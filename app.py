from flask import Flask, render_template, request, redirect, jsonify, session
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
from dotenv import load_dotenv
import os
import re
import json

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "super_secret_session_key")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL:
    DATABASE_URL = "sqlite:///procurement.db"
elif DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = DATABASE_URL
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"pool_pre_ping": True, "pool_recycle": 300}
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=8)
db = SQLAlchemy(app)

PORTAL_ROLE_HEADER = "X-Portal-Role"

def active_portal_role():
    header = (request.headers.get(PORTAL_ROLE_HEADER) or "").strip().lower()
    if header in {"manager", "staff", "supplier"}:
        return header
    return session.get("role")

def get_portals():
    return session.get("portals") or {}

def portal_data(role):
    return get_portals().get(role) or {}

def set_portal_data(role, data):
    portals = dict(get_portals())
    portals[role] = data
    session["portals"] = portals
    session.permanent = True
    session.modified = True
    sync_legacy_session_keys(role)

def sync_legacy_session_keys(role):
    session["role"] = role
    ps = portal_data(role)
    if role == "manager":
        session["manager_authenticated"] = bool(ps.get("authenticated"))
        session["manager_username"] = ps.get("username")
        session["password_expired"] = bool(ps.get("password_expired"))
    elif role in {"staff", "supplier"}:
        session["username"] = ps.get("username")
        session["password_expired"] = bool(ps.get("password_expired"))

def migrate_legacy_session():
    if get_portals():
        return
    portals = {}
    if session.get("manager_authenticated"):
        portals["manager"] = {
            "authenticated": True,
            "username": session.get("manager_username"),
            "password_expired": bool(session.get("password_expired")),
        }
    role = session.get("role")
    if role in {"staff", "supplier"} and session.get("username"):
        portals[role] = {
            "username": session.get("username"),
            "password_expired": bool(session.get("password_expired")),
        }
    if portals:
        session["portals"] = portals

@app.before_request
def _prepare_portal_session():
    migrate_legacy_session()

def portal_username(role=None):
    role = role or active_portal_role()
    return portal_data(role).get("username")

MANAGER_ACTIVITY_KEYWORDS = (
    "purchase request", "purchase order", "supplier", "delivery", "user", "account",
    "support", "ingredient", "inventory", "approved", "rejected", "registered", "restock",
)
STAFF_ACTIVITY_KEYWORDS = (
    "stock", "adjustment", "purchase request", "delivery", "receiving", "inventory", "support",
)

# Database Tables
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column("email", db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    role = db.Column(db.String(50), nullable=False)
    is_disabled = db.Column(db.Boolean, nullable=False, default=False)
    password_changed_at = db.Column(db.DateTime, nullable=True)

FIXED_MANAGER_ACCOUNTS = {
    "mgr.primary": "BMR_Primary@2026",
    "mgr.backup": "BMR_Backup@2026"
}

class ManagerCredential(db.Model):
    username = db.Column(db.String(120), primary_key=True)
    password_hash = db.Column(db.String(256), nullable=False)
    password_changed_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

PASSWORD_EXPIRY_DAYS = 30
PASSWORD_CHANGE_COOLDOWN_DAYS = 30
PASSWORD_MIN_LENGTH = 10
PASSWORD_HISTORY_LIMIT = 3
PASSWORD_REQUIREMENT_MESSAGE = "Password must contain at least 10 characters, including uppercase, lowercase, number, and special character."
SAME_PASSWORD_MESSAGE = "New password can't be the same as the current password."
PASSWORD_CHANGE_COOLDOWN_MESSAGE = "You can only change your password once every 30 days. Please try again later."
LOGIN_ERROR_MESSAGE = "Please enter the correct username and password."

PO_STATUS_PRIORITY = {
    "Awaiting approval": 0,
    "Waiting for Supplier": 1,
    "Transmitted": 2,
    "Accepted": 3,
    "In Transit": 4,
    "Delivered": 5,
    "Partial": 6,
    "Rejected": 7,
    "Rejected by Supplier": 8,
}

def default_reorder_qty(threshold):
    return max(float(threshold or 0) * 2, 50.0)

def inventory_item_payload(item):
    price = get_supplier_price(item.supplier_name, item.name)
    return {
        "id": item.id,
        "name": item.name,
        "stock": item.stock,
        "threshold": item.threshold,
        "unit": item.unit,
        "supplier": item.supplier_name,
        "price": price,
        "reorderQty": default_reorder_qty(item.threshold),
    }

class Inventory(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    stock = db.Column(db.Float, default=0)
    threshold = db.Column(db.Float, default=0)
    unit = db.Column(db.String(20))
    supplier_name = db.Column(db.String(100))

class Supplier(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(120))
    phone = db.Column(db.String(50))
    catalog = db.Column(db.Text, default="[]")

class PurchaseOrder(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    item_name = db.Column(db.String(100))
    qty = db.Column(db.Float)
    unit = db.Column(db.String(20))
    supplier = db.Column(db.String(100))
    supplier_id = db.Column(db.String(20), nullable=True)
    total = db.Column(db.Float)
    status = db.Column(db.String(50))
    type = db.Column(db.String(50))
    date = db.Column(db.String(50))
    expected_delivery_date = db.Column(db.String(50), nullable=True)
    source_pr_id = db.Column(db.String(50), nullable=True)

class ActivityLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    event = db.Column(db.String(200))
    item = db.Column(db.String(100))
    reference = db.Column(db.String(100))
    status = db.Column(db.String(50))
    time = db.Column(db.String(50))

class DeliveryRecord(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    qr_value = db.Column(db.String(200))
    po_id = db.Column(db.String(50))
    status = db.Column(db.String(50))
    time = db.Column(db.String(50))
    resolution_id = db.Column(db.String(50), nullable=True)

class DeliveryResolution(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    resolution_id = db.Column(db.String(50), unique=True, nullable=False)
    po_id = db.Column(db.String(50), nullable=False)
    original_delivery_id = db.Column(db.String(50), nullable=True)
    new_delivery_id = db.Column(db.String(50), nullable=True)
    supplier = db.Column(db.String(100), nullable=False)
    item_name = db.Column(db.String(100), nullable=False)
    quantity = db.Column(db.Float, default=0)
    unit = db.Column(db.String(20))
    action = db.Column(db.String(50), nullable=False)
    status = db.Column(db.String(50), default="Open")
    rejection_reason = db.Column(db.Text)
    manager_note = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.now)
    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)

ACTIVE_SHIPMENT_STATUSES = {
    "In Transit", "QR Generated", "Pending Redelivery", "Pending Replacement",
}

class StockAdjustment(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    inventory_id = db.Column(db.Integer, nullable=False)
    item_name = db.Column(db.String(100), nullable=False)
    adjustment_type = db.Column(db.String(50), nullable=False)
    quantity = db.Column(db.Float, nullable=False)
    reason = db.Column(db.String(250), nullable=False)
    previous_stock = db.Column(db.Float, nullable=False)
    new_stock = db.Column(db.Float, nullable=False)
    staff_username = db.Column(db.String(120), nullable=False)
    date = db.Column(db.String(80), nullable=False)

class ReceivingRecord(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    delivery_id = db.Column(db.String(50), unique=True, nullable=False)
    po_id = db.Column(db.String(50), nullable=False)
    supplier = db.Column(db.String(100), nullable=False)
    item_name = db.Column(db.String(100), nullable=False)
    expected_quantity = db.Column(db.Float, nullable=False)
    received_quantity = db.Column(db.Float, nullable=False)
    condition = db.Column(db.String(50), nullable=False)
    status = db.Column(db.String(50), nullable=False)
    received_by = db.Column(db.String(120), nullable=False)
    date_received = db.Column(db.String(80), nullable=False)
    rejection_reason = db.Column(db.Text, nullable=True)
    resolution_action = db.Column(db.String(50), nullable=True)
    resolution_status = db.Column(db.String(50), nullable=True)

class ManagerProfile(db.Model):
    username = db.Column(db.String(120), primary_key=True)
    full_name = db.Column(db.String(120), default="")
    email = db.Column(db.String(120), default="")
    contact_number = db.Column(db.String(50), default="")
    avatar_data = db.Column(db.Text, default="")

class UserProfile(db.Model):
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), primary_key=True)
    full_name = db.Column(db.String(120), default="")
    email = db.Column(db.String(120), default="")
    contact_number = db.Column(db.String(50), default="")
    avatar_data = db.Column(db.Text, default="")
    company_name = db.Column(db.String(120), default="")
    contact_person = db.Column(db.String(120), default="")
    business_address = db.Column(db.Text, default="")
    supplier_id = db.Column(db.String(20), default="")
    logo_data = db.Column(db.Text, default="")

class PasswordHistory(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    account_type = db.Column(db.String(20), nullable=False)
    account_key = db.Column(db.String(120), nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.now)

class PurchaseRequest(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    item_name = db.Column(db.String(100), nullable=False)
    qty = db.Column(db.Float, nullable=False)
    unit = db.Column(db.String(20))
    reason = db.Column(db.Text)
    requested_by = db.Column(db.String(120), nullable=False)
    supplier_name = db.Column(db.String(100))
    status = db.Column(db.String(50), default="Pending")
    date = db.Column(db.String(80))
    review_note = db.Column(db.Text)
    created_at = db.Column(db.DateTime, nullable=True)

class Notification(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    recipient_role = db.Column(db.String(50), nullable=False)
    recipient_key = db.Column(db.String(120), nullable=False)
    event_type = db.Column(db.String(50), nullable=False)
    title = db.Column(db.String(200), nullable=False)
    message = db.Column(db.Text, nullable=False)
    reference = db.Column(db.String(100), default="")
    is_read = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, default=datetime.now)

class SupportRequest(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.String(20), unique=True, nullable=False)
    username = db.Column(db.String(120), nullable=False)
    role = db.Column(db.String(50), nullable=False)
    category = db.Column(db.String(50), nullable=False)
    subject = db.Column(db.String(200), nullable=False)
    message = db.Column(db.Text, nullable=False)
    status = db.Column(db.String(50), default="Open")
    date = db.Column(db.String(80))

# --- HELPER FUNCTION: Get Price ---
def get_supplier_price(supplier_name, item_name):
    supplier = Supplier.query.filter_by(name=supplier_name).first()
    if supplier and supplier.catalog:
        try:
            catalog = json.loads(supplier.catalog)
            for entry in catalog:
                if entry.get("itemName", "").lower() == item_name.lower():
                    return float(entry.get("price", 150))
        except:
            pass
    return 150.0

def normalize_supplier_name(value):
    return str(value or "").strip().lower()

def current_local_datetime():
    return datetime.now()

def format_pr_datetime(dt):
    return dt.strftime("%B %d, %Y · %I:%M %p")

def format_pr_date(dt):
    if isinstance(dt, datetime):
        return dt.strftime("%B %d, %Y")
    text = str(dt or "").strip()
    if " · " in text:
        return text.split(" · ", 1)[0]
    return text

def purchase_request_created_at(record):
    if record.created_at:
        return record.created_at
    match = re.search(r"(\d{14})", record.id or "")
    if match:
        try:
            return datetime.strptime(match.group(1), "%Y%m%d%H%M%S")
        except ValueError:
            pass
    return current_local_datetime()

def purchase_request_sort_key(record):
    status_order = {"Pending": 0, "Approved": 1, "Rejected": 2}
    created = purchase_request_created_at(record)
    return (status_order.get(record.status, 9), -created.timestamp())

def purchase_request_payload(record):
    item = Inventory.query.filter(db.func.lower(Inventory.name) == record.item_name.lower()).first()
    created = purchase_request_created_at(record)
    return {
        "id": record.id,
        "itemName": record.item_name,
        "qty": record.qty,
        "unit": record.unit,
        "reason": record.reason,
        "requestedBy": record.requested_by,
        "supplierName": record.supplier_name or (item.supplier_name if item else "") or "",
        "status": record.status,
        "date": format_pr_date(created),
        "submittedAt": format_pr_datetime(created),
        "reviewNote": record.review_note,
    }

def supplier_matches_company(order_supplier, company):
    if not company:
        return False
    left = normalize_supplier_name(order_supplier)
    right = normalize_supplier_name(company)
    return bool(left) and left == right

def purchase_orders_for_supplier(username):
    company = get_supplier_company_for_user(username)
    if not company:
        return []
    return [
        order for order in PurchaseOrder.query.order_by(PurchaseOrder.id.desc()).all()
        if supplier_matches_company(order.supplier, company)
    ]

def parse_delivery_lookup(raw):
    text = str(raw or "").strip()
    if not text:
        return ""
    if text.upper().startswith("BYTEME:"):
        text = text.split(":", 1)[1].strip()
    if text.startswith("{") and text.endswith("}"):
        try:
            payload = json.loads(text)
            return str(payload.get("deliveryId") or payload.get("poId") or "").strip()
        except (TypeError, json.JSONDecodeError):
            pass
    return text

def delivery_id_for_po(po_id):
    clean_id = "".join(character for character in str(po_id) if character.isalnum())
    return f"DEL-{clean_id[-8:].upper()}"

def new_delivery_id_for_po(po_id):
    clean_id = "".join(character for character in str(po_id) if character.isalnum())[-6:]
    stamp = datetime.now().strftime("%H%M%S")
    return f"DEL-{clean_id.upper()}-{stamp}"

def find_receiving_for_resolution(delivery_id=None, po_number=None):
    lookup = parse_delivery_lookup(delivery_id or "")
    if lookup:
        receipt = ReceivingRecord.query.filter(
            db.func.lower(ReceivingRecord.delivery_id) == lookup.lower()
        ).first()
        if receipt:
            return receipt
        if lookup.upper().startswith("PO-"):
            po_number = po_number or lookup
    if po_number:
        return ReceivingRecord.query.filter_by(po_id=po_number).order_by(
            ReceivingRecord.id.desc()
        ).first()
    return None

def find_active_shipment(delivery_id=None, po_id=None):
    lookup = parse_delivery_lookup(delivery_id or "")
    if lookup:
        shipment = DeliveryRecord.query.filter(
            db.func.lower(DeliveryRecord.qr_value) == lookup.lower()
        ).first()
        if shipment and (shipment.status or "") in ACTIVE_SHIPMENT_STATUSES:
            return shipment
    if po_id:
        for shipment in DeliveryRecord.query.filter_by(po_id=po_id).order_by(DeliveryRecord.id.desc()).all():
            if (shipment.status or "") in ACTIVE_SHIPMENT_STATUSES:
                return shipment
    return None

def successful_receipt_for_po(po_id):
    return ReceivingRecord.query.filter_by(po_id=po_id).filter(
        ReceivingRecord.status.in_(["Delivered", "Partial"])
    ).first()

def active_delivery_id_for_po(po_id):
    shipment = find_active_shipment(po_id=po_id)
    if shipment:
        return shipment.qr_value
    resolution = DeliveryResolution.query.filter_by(po_id=po_id).filter(
        DeliveryResolution.new_delivery_id.isnot(None),
        DeliveryResolution.status.in_(["In Progress", "Open", "Pending Manager Review", "Approved"]),
    ).order_by(DeliveryResolution.id.desc()).first()
    if resolution and resolution.new_delivery_id:
        return resolution.new_delivery_id
    return delivery_id_for_po(po_id)

def resolution_payload(record):
    return {
        "id": record.id,
        "resolutionId": record.resolution_id,
        "poNumber": record.po_id,
        "originalDeliveryId": record.original_delivery_id or "",
        "newDeliveryId": record.new_delivery_id or "",
        "supplier": record.supplier,
        "itemName": record.item_name,
        "quantity": record.quantity,
        "unit": record.unit or "",
        "action": record.action,
        "status": record.status,
        "supplierResolutionStatus": normalize_resolution_status(record.status),
        "rejectionReason": record.rejection_reason or "",
        "managerNote": record.manager_note or "",
        "managerUpdatedAt": record.updated_at.strftime("%B %d, %Y · %I:%M %p") if record.updated_at else "",
        "date": record.created_at.strftime("%B %d, %Y · %I:%M %p") if record.created_at else "",
        "resolutionLocked": resolution_is_locked(record),
    }

def normalize_resolution_status(status):
    if not status:
        return ""
    legacy_map = {
        "Open": "Pending Manager Review",
        "In Progress": "Pending Manager Review",
        "Refund Pending": "Pending Manager Review",
        "Refund in Progress": "Pending Manager Review",
        "Closed": "Completed",
        "Resolved": "Completed",
    }
    return legacy_map.get(status, status)

def resolution_is_locked(record):
    if not record:
        return False
    label = normalize_resolution_status(record.status)
    return label not in {"Completed", "Rejected", "Reopened"}

def supplier_resolution_fields(record):
    if not record:
        return {
            "managerNote": "",
            "managerUpdatedAt": "",
            "supplierResolutionStatus": "",
            "resolutionLocked": False,
            "resolutionId": "",
        }
    return {
        "managerNote": record.manager_note or "",
        "managerUpdatedAt": record.updated_at.strftime("%B %d, %Y · %I:%M %p") if record.updated_at else "",
        "supplierResolutionStatus": normalize_resolution_status(record.status),
        "resolutionLocked": resolution_is_locked(record),
        "resolutionId": record.resolution_id,
    }

def find_order_for_delivery_lookup(delivery_id):
    lookup = parse_delivery_lookup(delivery_id)
    if not lookup:
        return None
    shipment = DeliveryRecord.query.filter(
        db.func.lower(DeliveryRecord.qr_value) == lookup.lower()
    ).first()
    if shipment:
        order = PurchaseOrder.query.get(shipment.po_id)
        if order:
            return order
    receipt = ReceivingRecord.query.filter(
        db.func.lower(ReceivingRecord.delivery_id) == lookup.lower()
    ).first()
    if receipt:
        return PurchaseOrder.query.get(receipt.po_id)
    for order in PurchaseOrder.query.all():
        if delivery_id_for_po(order.id).lower() == lookup.lower():
            return order
        if str(order.id).lower() == lookup.lower():
            return order
    return None

def notification_recipient_key(role, username=None):
    if role == "manager":
        return "manager"
    if role == "supplier":
        return get_supplier_company_for_user(username) or username or ""
    return username or ""

def create_notification(recipient_role, recipient_key, event_type, title, message, reference=""):
    if not recipient_key:
        return
    db.session.add(Notification(
        recipient_role=recipient_role,
        recipient_key=recipient_key,
        event_type=event_type,
        title=title,
        message=message,
        reference=reference or "",
    ))

def create_po_from_purchase_request(pr_record):
    """Create and send a purchase order when a purchase request is approved."""
    existing = PurchaseOrder.query.filter_by(source_pr_id=pr_record.id).first()
    if existing:
        return existing

    item = Inventory.query.filter(db.func.lower(Inventory.name) == pr_record.item_name.lower()).first()
    supplier = pr_record.supplier_name or (item.supplier_name if item and item.supplier_name else "Default Supplier")
    unit = pr_record.unit or (item.unit if item else "pcs")
    price = get_supplier_price(supplier, pr_record.item_name)
    po_id = f"PO-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    supplier_record = Supplier.query.filter_by(name=supplier).first()
    supplier_id = f"SUP-{supplier_record.id:04d}" if supplier_record else ""
    expected_delivery = (datetime.now() + timedelta(days=3)).strftime("%B %d, %Y")

    po = PurchaseOrder(
        id=po_id,
        item_name=pr_record.item_name,
        qty=pr_record.qty,
        unit=unit,
        supplier=supplier,
        supplier_id=supplier_id,
        total=pr_record.qty * price,
        status="Waiting for Supplier",
        type="From Purchase Request",
        date=datetime.now().strftime("%B %d, %Y"),
        expected_delivery_date=expected_delivery,
        source_pr_id=pr_record.id,
    )
    db.session.add(po)
    db.session.add(ActivityLog(
        event="Purchase Order Sent to Supplier",
        item=pr_record.item_name,
        reference=po_id,
        status="Waiting for Supplier",
        time=datetime.now().strftime("%H:%M"),
    ))
    create_notification(
        "supplier",
        supplier,
        "new_purchase_order",
        "New Purchase Order",
        f"PO {po_id} for {pr_record.item_name} ({pr_record.qty} {unit}) is waiting for your response.",
        po_id,
    )
    create_notification(
        "manager",
        "manager",
        "purchase_order_sent",
        "Purchase Order Sent",
        f"PO {po_id} was sent to {supplier} after approving {pr_record.id}.",
        po_id,
    )
    return po

def sync_low_stock_alerts():
    """Scan inventory and auto-create purchase requests for low-stock items."""
    low_items = Inventory.query.filter(Inventory.stock <= Inventory.threshold).all()
    for item in low_items:
        check_and_auto_purchase_request(item.id, requested_by="staff")
    db.session.commit()

def check_and_auto_purchase_request(item_id, requested_by=None):
    """Create a pending purchase request when stock drops to or below threshold."""
    item = Inventory.query.get(item_id)
    if not item or float(item.stock or 0) > float(item.threshold or 0):
        return None

    existing_pr = PurchaseRequest.query.filter_by(
        item_name=item.name,
        status="Pending",
    ).first()
    if existing_pr:
        return existing_pr

    reorder_qty = default_reorder_qty(item.threshold)
    req_id = f"PR-AUTO-{datetime.now().strftime('%Y%m%d%H%M%S')}-{item.id}"
    submitted_at = current_local_datetime()
    record = PurchaseRequest(
        id=req_id,
        item_name=item.name,
        qty=reorder_qty,
        unit=item.unit if item.unit else "pcs",
        reason=f"Auto-generated: stock ({item.stock} {item.unit or 'units'}) at or below threshold ({item.threshold}).",
        requested_by=requested_by or "staff",
        supplier_name=item.supplier_name or "",
        status="Pending",
        date=format_pr_datetime(submitted_at),
        created_at=submitted_at,
    )
    db.session.add(record)
    db.session.add(ActivityLog(
        event="Auto Purchase Request Created",
        item=item.name,
        reference=req_id,
        status="Pending",
        time=datetime.now().strftime("%H:%M"),
    ))
    return record

def seed_demo_data():
    """Populate sample suppliers, inventory, POs, and activity for first-run demos."""
    if Inventory.query.first():
        return

    suppliers = [
        Supplier(
            name="Metro Meats Supply",
            email="orders@metromeats.ph",
            phone="+63 917 555 0101",
            catalog=json.dumps([
                {"itemName": "Beef Ribs", "price": 480},
                {"itemName": "Chicken Breast", "price": 220},
                {"itemName": "Pork Belly", "price": 350},
            ]),
        ),
        Supplier(
            name="Fresh Harvest Trading",
            email="sales@freshharvest.ph",
            phone="+63 918 555 0202",
            catalog=json.dumps([
                {"itemName": "Roma Tomatoes", "price": 85},
                {"itemName": "Yellow Onions", "price": 55},
                {"itemName": "Garlic", "price": 180},
            ]),
        ),
        Supplier(
            name="Golden Grain Co.",
            email="procurement@goldengrain.ph",
            phone="+63 919 555 0303",
            catalog=json.dumps([
                {"itemName": "Jasmine Rice", "price": 52},
                {"itemName": "Cooking Oil", "price": 95},
                {"itemName": "All-Purpose Flour", "price": 48},
            ]),
        ),
    ]
    for supplier in suppliers:
        db.session.add(supplier)

    inventory_items = [
        Inventory(name="Beef Ribs", stock=18, threshold=25, unit="kg", supplier_name="Metro Meats Supply"),
        Inventory(name="Chicken Breast", stock=42, threshold=30, unit="kg", supplier_name="Metro Meats Supply"),
        Inventory(name="Roma Tomatoes", stock=8, threshold=15, unit="kg", supplier_name="Fresh Harvest Trading"),
        Inventory(name="Yellow Onions", stock=22, threshold=20, unit="kg", supplier_name="Fresh Harvest Trading"),
        Inventory(name="Jasmine Rice", stock=12, threshold=25, unit="kg", supplier_name="Golden Grain Co."),
        Inventory(name="Cooking Oil", stock=6, threshold=10, unit="L", supplier_name="Golden Grain Co."),
        Inventory(name="Garlic", stock=3, threshold=5, unit="kg", supplier_name="Fresh Harvest Trading"),
    ]
    for item in inventory_items:
        db.session.add(item)
    db.session.commit()

    today = datetime.now().strftime("%B %d, %Y")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%B %d, %Y")

    sample_orders = [
        PurchaseOrder(
            id="PO-20260620001",
            item_name="Chicken Breast",
            qty=40,
            unit="kg",
            supplier="Metro Meats Supply",
            total=8800,
            status="Waiting for Supplier",
            type="Manual Request",
            date=yesterday,
        ),
        PurchaseOrder(
            id="PO-20260618001",
            item_name="Yellow Onions",
            qty=30,
            unit="kg",
            supplier="Fresh Harvest Trading",
            total=1650,
            status="Delivered",
            type="Manual Request",
            date=(datetime.now() - timedelta(days=3)).strftime("%B %d, %Y"),
        ),
        PurchaseOrder(
            id="PO-20260615001",
            item_name="All-Purpose Flour",
            qty=50,
            unit="kg",
            supplier="Golden Grain Co.",
            total=2400,
            status="Rejected",
            type="Manual Request",
            date=(datetime.now() - timedelta(days=5)).strftime("%B %d, %Y"),
        ),
    ]
    for order in sample_orders:
        db.session.add(order)

    db.session.add(ReceivingRecord(
        delivery_id="DEL-062001",
        po_id="PO-20260618001",
        supplier="Fresh Harvest Trading",
        item_name="Yellow Onions",
        expected_quantity=30,
        received_quantity=30,
        condition="Good Condition",
        status="Delivered",
        received_by="staff",
        date_received=yesterday + " · 02:15 PM",
    ))

    activity_entries = [
        ActivityLog(event="System Initialized", item="Demo Data", reference="SEED-001", status="Complete", time="08:00"),
        ActivityLog(event="Delivery Received", item="Yellow Onions", reference="DEL-062001", status="Delivered", time="14:15"),
        ActivityLog(event="Purchase Order Approved", item="Chicken Breast", reference="PO-20260620001", status="Transmitted", time="11:30"),
        ActivityLog(event="Manual PO Queued", item="Chicken Breast", reference="PO-20260620001", status="Awaiting approval", time="10:45"),
        ActivityLog(event="Low Stock Detected", item="Beef Ribs", reference="18 kg remaining", status="Alert", time="09:20"),
        ActivityLog(event="Low Stock Detected", item="Garlic", reference="3 kg remaining", status="Critical", time="09:18"),
        ActivityLog(event="Purchase Order Rejected", item="All-Purpose Flour", reference="PO-20260615001", status="Rejected", time="16:40"),
        ActivityLog(event="Supplier Registered", item="Metro Meats Supply", reference="SUP-001", status="Active", time="08:05"),
        ActivityLog(event="Supplier Registered", item="Fresh Harvest Trading", reference="SUP-002", status="Active", time="08:06"),
        ActivityLog(event="Supplier Registered", item="Golden Grain Co.", reference="SUP-003", status="Active", time="08:07"),
    ]
    for entry in activity_entries:
        db.session.add(entry)

    db.session.add(PurchaseRequest(
        id="PR-20260624001", item_name="Garlic", qty=10, unit="kg",
        reason="Critical stock level — needed for weekend service.",
        requested_by="staff", status="Pending",
        date=(datetime.now() - timedelta(days=1)).strftime("%B %d, %Y · %I:%M %p"),
    ))
    db.session.add(PurchaseRequest(
        id="PR-20260622001", item_name="Cooking Oil", qty=20, unit="L",
        reason="Restock for frying station.", requested_by="staff", status="Approved",
        date=(datetime.now() - timedelta(days=3)).strftime("%B %d, %Y · %I:%M %p"),
    ))
    db.session.add(SupportRequest(
        ticket_id="TKT-20260624001", username="staff", role="staff",
        category="Delivery Concern", subject="Late delivery from Metro Meats",
        message="Expected delivery yesterday but no update received.",
        status="Open", date=yesterday + " · 09:30 AM",
    ))

    db.session.commit()

# page redirection
@app.route("/")
def login_page():
    return render_template("index.html")

@app.route("/staff")
def staff():
    ps = portal_data("staff")
    if not ps.get("username"):
        return redirect("/")
    sync_legacy_session_keys("staff")
    if ps.get("password_expired"):
        return redirect("/change-password?portal=staff")
    user = User.query.filter_by(username=ps.get("username"), role="staff").first()
    days_remaining = password_days_remaining(user) if user else PASSWORD_EXPIRY_DAYS
    return render_template("staff.html", username=ps.get("username", "staff"), days_remaining=days_remaining)

@app.route("/manager")
def manager():
    ps = portal_data("manager")
    if not ps.get("authenticated"):
        return redirect("/")
    sync_legacy_session_keys("manager")
    if ps.get("password_expired"):
        return redirect("/change-password?portal=manager")
    mgr = ManagerCredential.query.filter_by(username=ps.get("username")).first()
    days_remaining = manager_password_days_remaining(mgr) if mgr else PASSWORD_EXPIRY_DAYS
    return render_template("manager.html", is_manager=True, username=ps.get("username", "mgr.primary"), days_remaining=days_remaining)

@app.route("/profile")
def profile_page():
    role = request.args.get("portal") or active_portal_role()
    if role not in {"manager", "staff", "supplier"}:
        return redirect("/")
    ps = portal_data(role)
    if role == "manager" and not ps.get("authenticated"):
        return redirect("/")
    if role in {"staff", "supplier"} and not ps.get("username"):
        return redirect("/")
    sync_legacy_session_keys(role)
    if ps.get("password_expired"):
        return redirect(f"/change-password?portal={role}")
    username = portal_username(role)
    return render_template("profile.html", username=username, role=role)

@app.route("/supplier")
def supplier():
    ps = portal_data("supplier")
    if not ps.get("username"):
        return redirect("/")
    sync_legacy_session_keys("supplier")
    if ps.get("password_expired"):
        return redirect("/change-password?portal=supplier")
    user = User.query.filter_by(username=ps.get("username"), role="supplier").first()
    days_remaining = password_days_remaining(user) if user else PASSWORD_EXPIRY_DAYS
    return render_template("supplier.html", username=ps.get("username", "supplier"), days_remaining=days_remaining)

# login
@app.route("/login", methods=["POST"])
def login():
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    selected_role = request.form.get("role")
    ensure_user_schema()

    if selected_role == "manager":
        manager_account = ManagerCredential.query.filter_by(username=username).first()
        if manager_account and check_password_hash(manager_account.password_hash, password):
            expired = manager_password_is_expired(manager_account)
            set_portal_data("manager", {
                "authenticated": True,
                "username": username,
                "password_expired": expired,
            })
            if expired:
                return redirect("/change-password?portal=manager")
            return redirect("/manager")
        return login_error_response()

    user = User.query.filter_by(username=username).first()
    if not user or not check_password_hash(user.password_hash, password):
        return login_error_response()
    if user.is_disabled:
        return '<script>alert("This account is disabled. Please contact the Manager."); window.history.back();</script>'
    account_role = user.role.lower()
    if selected_role not in {"staff", "supplier"} or account_role != selected_role:
        return login_error_response()

    expired = password_is_expired(user)
    set_portal_data(account_role, {
        "username": user.username,
        "password_expired": expired,
    })
    if expired:
        return redirect(f"/change-password?portal={account_role}")
    return redirect("/staff" if account_role == "staff" else "/supplier")

@app.route("/logout")
def logout():
    role = request.args.get("portal") or active_portal_role() or session.get("role")
    portals = dict(get_portals())
    if role in portals:
        del portals[role]
    session["portals"] = portals
    if session.get("role") == role:
        session.pop("role", None)
        session.pop("username", None)
        session.pop("manager_authenticated", None)
        session.pop("manager_username", None)
        session.pop("password_expired", None)
    if not get_portals():
        session.clear()
    return redirect("/")

@app.route("/change-password", methods=["GET", "POST"])
def change_password():
    role = request.args.get("portal") or session.get("role")
    if role not in {"manager", "staff", "supplier"}:
        return redirect("/")
    ps = portal_data(role)
    if role == "manager" and not ps.get("authenticated"):
        return redirect("/")
    if role in {"staff", "supplier"} and not ps.get("username"):
        return redirect("/")
    sync_legacy_session_keys(role)

    ensure_user_schema()
    username = portal_username(role)
    expired = bool(ps.get("password_expired"))
    cooldown_active = password_change_cooldown_active(role, username, allow_if_expired=True)
    days_until_change = password_days_until_change_allowed(role, username)
    error = None

    if request.method == "POST":
        if cooldown_active and not expired:
            error = PASSWORD_CHANGE_COOLDOWN_MESSAGE
        else:
            current_password = request.form.get("current_password", "")
            new_password = request.form.get("new_password", "")
            confirm_password = request.form.get("confirm_password", "")

            if new_password != confirm_password:
                error = "New password and confirmation do not match."
            elif not password_meets_requirements(new_password):
                error = PASSWORD_REQUIREMENT_MESSAGE
            elif password_matches_current(role, username, new_password):
                error = SAME_PASSWORD_MESSAGE
            elif password_was_used_recently(role, username, new_password):
                error = "You cannot reuse any of your last 3 passwords."
            elif role == "manager":
                account = ManagerCredential.query.filter_by(username=username).first()
                if not account or not check_password_hash(account.password_hash, current_password):
                    error = "Current password is incorrect."
                else:
                    record_password_history("manager", username, account.password_hash)
                    account.password_hash = generate_password_hash(new_password)
                    account.password_changed_at = datetime.now()
            else:
                user = User.query.filter_by(username=username, role=role).first()
                if not user or not check_password_hash(user.password_hash, current_password):
                    error = "Current password is incorrect."
                else:
                    record_password_history(role, username, user.password_hash)
                    user.password_hash = generate_password_hash(new_password)
                    user.password_changed_at = datetime.now()

        if not error:
            db.session.commit()
            ps = dict(portal_data(role))
            ps["password_expired"] = False
            set_portal_data(role, ps)
            session.pop("password_expired", None)
            destination = "/manager" if role == "manager" else f"/{role}"
            return f'<script>alert("Password updated successfully."); window.location.href="{destination}";</script>'

    return render_template(
        "change_password.html",
        username=username,
        role=role,
        expired=expired,
        error=error,
        requirement_message=PASSWORD_REQUIREMENT_MESSAGE,
        cooldown_active=cooldown_active and not expired,
        days_until_change=days_until_change,
        cooldown_message=PASSWORD_CHANGE_COOLDOWN_MESSAGE,
    )

def manager_api_allowed():
    if active_portal_role() != "manager":
        return False
    ps = portal_data("manager")
    return bool(ps.get("authenticated") and not ps.get("password_expired"))

def login_error_response():
    return f'<script>alert("{LOGIN_ERROR_MESSAGE}"); window.history.back();</script>'

def password_meets_requirements(password):
    return bool(
        len(password) >= PASSWORD_MIN_LENGTH
        and re.search(r"[A-Z]", password)
        and re.search(r"[a-z]", password)
        and re.search(r"\d", password)
        and re.search(r"[^A-Za-z0-9]", password)
    )

def manager_password_is_expired(account):
    return not account.password_changed_at or datetime.now() - account.password_changed_at >= timedelta(days=PASSWORD_EXPIRY_DAYS)

def manager_password_days_remaining(account):
    if not account or not account.password_changed_at:
        return 0
    expiry = account.password_changed_at + timedelta(days=PASSWORD_EXPIRY_DAYS)
    return max(0, (expiry - datetime.now()).days)

def record_password_history(account_type, account_key, password_hash):
    db.session.add(PasswordHistory(account_type=account_type, account_key=account_key, password_hash=password_hash))
    histories = PasswordHistory.query.filter_by(account_type=account_type, account_key=account_key).order_by(PasswordHistory.id.desc()).all()
    for old in histories[PASSWORD_HISTORY_LIMIT:]:
        db.session.delete(old)

def password_matches_current(account_type, account_key, new_password):
    if account_type == "manager":
        account = ManagerCredential.query.filter_by(username=account_key).first()
    else:
        account = User.query.filter_by(username=account_key, role=account_type).first()
    return bool(account and check_password_hash(account.password_hash, new_password))

def password_change_cooldown_active(role, username, allow_if_expired=True):
    if role == "manager":
        account = ManagerCredential.query.filter_by(username=username).first()
        if not account or not account.password_changed_at:
            return False
        if allow_if_expired and manager_password_is_expired(account):
            return False
        return datetime.now() - account.password_changed_at < timedelta(days=PASSWORD_CHANGE_COOLDOWN_DAYS)
    user = User.query.filter_by(username=username, role=role).first()
    if not user or not user.password_changed_at:
        return False
    if allow_if_expired and password_is_expired(user):
        return False
    return datetime.now() - user.password_changed_at < timedelta(days=PASSWORD_CHANGE_COOLDOWN_DAYS)

def password_days_until_change_allowed(role, username):
    changed_at = None
    if role == "manager":
        account = ManagerCredential.query.filter_by(username=username).first()
        changed_at = account.password_changed_at if account else None
    else:
        user = User.query.filter_by(username=username, role=role).first()
        changed_at = user.password_changed_at if user else None
    if not changed_at:
        return 0
    next_allowed = changed_at + timedelta(days=PASSWORD_CHANGE_COOLDOWN_DAYS)
    return max(0, (next_allowed - datetime.now()).days + (1 if (next_allowed - datetime.now()).seconds > 0 else 0))

def password_was_used_recently(account_type, account_key, new_password):
    histories = PasswordHistory.query.filter_by(account_type=account_type, account_key=account_key).order_by(PasswordHistory.id.desc()).limit(PASSWORD_HISTORY_LIMIT).all()
    for entry in histories:
        if check_password_hash(entry.password_hash, new_password):
            return True
    return False

def supplier_api_allowed():
    if active_portal_role() != "supplier":
        return False
    ps = portal_data("supplier")
    return bool(ps.get("username") and not ps.get("password_expired"))

def sync_supplier_catalog_price(supplier_name, item_name, price):
    supplier = Supplier.query.filter_by(name=supplier_name).first()
    if not supplier:
        return
    try:
        catalog = json.loads(supplier.catalog or "[]")
    except (TypeError, json.JSONDecodeError):
        catalog = []
    updated = False
    for entry in catalog:
        if entry.get("itemName", "").lower() == item_name.lower():
            entry["price"] = float(price)
            updated = True
            break
    if not updated:
        catalog.append({"itemName": item_name, "price": float(price)})
    supplier.catalog = json.dumps(catalog)

def add_catalog_items_to_inventory(supplier_name, catalog, default_stock=0):
    for entry in catalog or []:
        item_name = str(entry.get("itemName", "")).strip()
        if not item_name:
            continue
        existing = Inventory.query.filter(db.func.lower(Inventory.name) == item_name.lower()).first()
        if existing:
            continue
        db.session.add(Inventory(
            name=item_name,
            stock=float(entry.get("stock", default_stock) or 0),
            threshold=float(entry.get("threshold", 10) or 10),
            unit=str(entry.get("unit", "pcs") or "pcs"),
            supplier_name=supplier_name,
        ))

def get_supplier_company_for_user(username):
    user = User.query.filter_by(username=username, role="supplier").first()
    if not user:
        return None
    profile = UserProfile.query.filter_by(user_id=user.id).first()
    if profile and profile.company_name:
        return profile.company_name
    return username

def profile_payload(role, username):
    if role == "manager":
        profile = ManagerProfile.query.filter_by(username=username).first()
        if not profile:
            profile = ManagerProfile(username=username)
            db.session.add(profile)
            db.session.commit()
        return {
            "username": username,
            "role": "Manager",
            "fullName": profile.full_name or "",
            "email": profile.email or "",
            "contactNumber": profile.contact_number or "",
            "avatarData": profile.avatar_data or "",
        }
    user = User.query.filter_by(username=username, role=role).first()
    profile = UserProfile.query.filter_by(user_id=user.id).first() if user else None
    if user and not profile:
        profile = UserProfile(user_id=user.id, supplier_id=f"SUP-{user.id:04d}" if role == "supplier" else "")
        db.session.add(profile)
        db.session.commit()
    base = {
        "username": username,
        "role": "Inventory Staff" if role == "staff" else "Supplier",
        "fullName": profile.full_name if profile else "",
        "email": profile.email if profile else "",
        "contactNumber": profile.contact_number if profile else "",
        "avatarData": profile.avatar_data if profile else "",
        "disabled": user.is_disabled if user else False,
    }
    if role == "supplier" and profile:
        base.update({
            "supplierId": profile.supplier_id or f"SUP-{user.id:04d}",
            "companyName": profile.company_name or "",
            "contactPerson": profile.contact_person or "",
            "businessAddress": profile.business_address or "",
            "logoData": profile.logo_data or "",
        })
    return base

def password_is_expired(user):
    return not user.password_changed_at or datetime.now() - user.password_changed_at >= timedelta(days=PASSWORD_EXPIRY_DAYS)

def password_days_remaining(user):
    if not user or not user.password_changed_at:
        return 0
    expiry = user.password_changed_at + timedelta(days=PASSWORD_EXPIRY_DAYS)
    return max(0, (expiry - datetime.now()).days)

def ensure_user_schema():
    db.create_all()
    dialect = db.engine.dialect.name
    if dialect == "sqlite":
        columns = {row[1] for row in db.session.execute(text("PRAGMA table_info(user)"))}
        if "is_disabled" not in columns:
            db.session.execute(text("ALTER TABLE user ADD COLUMN is_disabled BOOLEAN NOT NULL DEFAULT 0"))
        if "password_changed_at" not in columns:
            db.session.execute(text("ALTER TABLE user ADD COLUMN password_changed_at DATETIME"))
        po_columns = {row[1] for row in db.session.execute(text("PRAGMA table_info(purchase_order)"))}
        if "source_pr_id" not in po_columns:
            db.session.execute(text("ALTER TABLE purchase_order ADD COLUMN source_pr_id VARCHAR(50)"))
        pr_columns = {row[1] for row in db.session.execute(text("PRAGMA table_info(purchase_request)"))}
        if "supplier_name" not in pr_columns:
            db.session.execute(text("ALTER TABLE purchase_request ADD COLUMN supplier_name VARCHAR(100)"))
        if "supplier_id" not in po_columns:
            db.session.execute(text("ALTER TABLE purchase_order ADD COLUMN supplier_id VARCHAR(20)"))
        if "expected_delivery_date" not in po_columns:
            db.session.execute(text("ALTER TABLE purchase_order ADD COLUMN expected_delivery_date VARCHAR(50)"))
        recv_columns = {row[1] for row in db.session.execute(text("PRAGMA table_info(receiving_record)"))}
        if "rejection_reason" not in recv_columns:
            db.session.execute(text("ALTER TABLE receiving_record ADD COLUMN rejection_reason TEXT"))
        if "resolution_action" not in recv_columns:
            db.session.execute(text("ALTER TABLE receiving_record ADD COLUMN resolution_action VARCHAR(50)"))
        if "resolution_status" not in recv_columns:
            db.session.execute(text("ALTER TABLE receiving_record ADD COLUMN resolution_status VARCHAR(50)"))
        pr_created_columns = {row[1] for row in db.session.execute(text("PRAGMA table_info(purchase_request)"))}
        if "created_at" not in pr_created_columns:
            db.session.execute(text("ALTER TABLE purchase_request ADD COLUMN created_at DATETIME"))
        dr_columns = {row[1] for row in db.session.execute(text("PRAGMA table_info(delivery_record)"))}
        if "resolution_id" not in dr_columns:
            db.session.execute(text("ALTER TABLE delivery_record ADD COLUMN resolution_id VARCHAR(50)"))
    else:
        columns = {
            row[0]
            for row in db.session.execute(text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'user'"
            ))
        }
        if "is_disabled" not in columns:
            db.session.execute(text('ALTER TABLE "user" ADD COLUMN is_disabled BOOLEAN NOT NULL DEFAULT FALSE'))
        if "password_changed_at" not in columns:
            db.session.execute(text('ALTER TABLE "user" ADD COLUMN password_changed_at TIMESTAMP'))
        po_columns = {
            row[0]
            for row in db.session.execute(text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'purchase_order'"
            ))
        }
        if "source_pr_id" not in po_columns:
            db.session.execute(text("ALTER TABLE purchase_order ADD COLUMN source_pr_id VARCHAR(50)"))
        pr_columns = {
            row[0]
            for row in db.session.execute(text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'purchase_request'"
            ))
        }
        if "supplier_name" not in pr_columns:
            db.session.execute(text("ALTER TABLE purchase_request ADD COLUMN supplier_name VARCHAR(100)"))
        if "supplier_id" not in po_columns:
            db.session.execute(text("ALTER TABLE purchase_order ADD COLUMN supplier_id VARCHAR(20)"))
        if "expected_delivery_date" not in po_columns:
            db.session.execute(text("ALTER TABLE purchase_order ADD COLUMN expected_delivery_date VARCHAR(50)"))
        recv_columns = {
            row[0]
            for row in db.session.execute(text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'receiving_record'"
            ))
        }
        if "rejection_reason" not in recv_columns:
            db.session.execute(text("ALTER TABLE receiving_record ADD COLUMN rejection_reason TEXT"))
        if "resolution_action" not in recv_columns:
            db.session.execute(text("ALTER TABLE receiving_record ADD COLUMN resolution_action VARCHAR(50)"))
        if "resolution_status" not in recv_columns:
            db.session.execute(text("ALTER TABLE receiving_record ADD COLUMN resolution_status VARCHAR(50)"))
        pr_created_columns = {
            row[0]
            for row in db.session.execute(text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'purchase_request'"
            ))
        }
        if "created_at" not in pr_created_columns:
            db.session.execute(text("ALTER TABLE purchase_request ADD COLUMN created_at TIMESTAMP"))
        dr_columns = {
            row[0]
            for row in db.session.execute(text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'delivery_record'"
            ))
        }
        if "resolution_id" not in dr_columns:
            db.session.execute(text("ALTER TABLE delivery_record ADD COLUMN resolution_id VARCHAR(50)"))
    db.session.commit()
    for record in PurchaseRequest.query.filter(PurchaseRequest.created_at.is_(None)).all():
        record.created_at = purchase_request_created_at(record)
    db.session.commit()
    for username, initial_password in FIXED_MANAGER_ACCOUNTS.items():
        if not ManagerCredential.query.filter_by(username=username).first():
            db.session.add(ManagerCredential(username=username, password_hash=generate_password_hash(initial_password), password_changed_at=datetime.now()))
    db.session.commit()

@app.route("/api/users")
def get_users():
    if not manager_api_allowed():
        return jsonify({"error": "Unauthorized"}), 401
    ensure_user_schema()
    users = User.query.filter(User.role.in_(["staff", "supplier"])).order_by(User.role, User.username).all()
    result = []
    for user in users:
        profile = UserProfile.query.filter_by(user_id=user.id).first()
        company_name = profile.company_name if profile else ""
        display_name = company_name if user.role == "supplier" and company_name else user.username
        result.append({
            "id": user.id,
            "username": user.username,
            "displayName": display_name,
            "companyName": company_name,
            "role": user.role,
            "disabled": user.is_disabled,
        })
    return jsonify(result)

@app.route("/api/users/save", methods=["POST"])
def save_user():
    if not manager_api_allowed():
        return jsonify({"error": "Unauthorized"}), 401
    ensure_user_schema()
    data = request.get_json(silent=True) or {}
    user_id = data.get("id")
    username = str(data.get("username", "")).strip()
    role = str(data.get("role", "")).lower()
    password = str(data.get("password", ""))
    company_name = str(data.get("companyName", "")).strip()
    catalog = data.get("catalog") or []
    if role not in {"staff", "supplier"}:
        return jsonify({"error": "A valid account type is required."}), 400
    if role == "staff" and not user_id:
        existing_staff = User.query.filter_by(role="staff", is_disabled=False).first()
        if existing_staff:
            return jsonify({"error": "Only one Inventory Staff account is allowed. Disable the existing account first."}), 409
    if role == "supplier" and not user_id:
        if not company_name:
            return jsonify({"error": "Company name is required when registering a supplier."}), 400
        if not catalog:
            return jsonify({"error": "Add at least one ingredient with an agreed price."}), 400
        username = company_name
    if not username:
        return jsonify({"error": "A username and valid account type are required."}), 400
    duplicate = User.query.filter_by(username=username).first()
    if duplicate and duplicate.id != user_id:
        return jsonify({"error": "That username is already in use."}), 409
    if user_id:
        user = User.query.filter_by(id=user_id).first()
        if not user or user.role not in {"staff", "supplier"}:
            return jsonify({"error": "Account not found."}), 404
        user.username = username
        user.role = role
        if role == "supplier" and company_name:
            profile = UserProfile.query.filter_by(user_id=user.id).first() or UserProfile(user_id=user.id)
            profile.company_name = company_name
            if data.get("email"):
                profile.email = str(data.get("email", "")).strip()
            if data.get("phone"):
                profile.contact_number = str(data.get("phone", "")).strip()
            if data.get("contactPerson"):
                profile.contact_person = str(data.get("contactPerson", "")).strip()
            db.session.add(profile)
    else:
        if not password_meets_requirements(password):
            return jsonify({"error": PASSWORD_REQUIREMENT_MESSAGE}), 400
        user = User(username=username, role=role, password_hash=generate_password_hash(password), password_changed_at=None)
        db.session.add(user)
        db.session.flush()
        profile = UserProfile(
            user_id=user.id,
            supplier_id=f"SUP-{user.id:04d}" if role == "supplier" else "",
            company_name=company_name if role == "supplier" else "",
            contact_person=str(data.get("contactPerson", data.get("fullName", ""))).strip() or (company_name if role == "supplier" else ""),
            email=str(data.get("email", "")).strip(),
            contact_number=str(data.get("phone", data.get("contactNumber", ""))).strip(),
            business_address=str(data.get("businessAddress", "")).strip(),
        )
        db.session.add(profile)
        if role == "supplier":
            supplier_record = Supplier.query.filter_by(name=company_name).first()
            if not supplier_record:
                supplier_record = Supplier(
                    name=company_name,
                    email=str(data.get("email", "")).strip(),
                    phone=str(data.get("phone", "")).strip(),
                    catalog=json.dumps(catalog),
                )
                db.session.add(supplier_record)
            else:
                supplier_record.catalog = json.dumps(catalog)
                if str(data.get("email", "")).strip():
                    supplier_record.email = str(data.get("email", "")).strip()
                if str(data.get("phone", "")).strip():
                    supplier_record.phone = str(data.get("phone", "")).strip()
            add_catalog_items_to_inventory(company_name, catalog)
            db.session.add(ActivityLog(
                event="Supplier Registered",
                item=company_name,
                reference=profile.supplier_id,
                status="Active",
                time=datetime.now().strftime("%H:%M"),
            ))
    db.session.commit()
    return jsonify({"status": "success"})

@app.route("/api/users/reset-password", methods=["POST"])
def reset_user_password():
    if not manager_api_allowed():
        return jsonify({"error": "Unauthorized"}), 401
    ensure_user_schema()
    data = request.get_json(silent=True) or {}
    user = User.query.filter_by(id=data.get("id")).first()
    password = str(data.get("password", ""))
    if not user or user.role not in {"staff", "supplier"}:
        return jsonify({"error": "Account and new password are required."}), 400
    if not password_meets_requirements(password):
        return jsonify({"error": PASSWORD_REQUIREMENT_MESSAGE}), 400
    user.password_hash = generate_password_hash(password)
    user.password_changed_at = None
    db.session.commit()
    return jsonify({"status": "success"})

@app.route("/api/users/toggle-disabled", methods=["POST"])
def toggle_user_disabled():
    if not manager_api_allowed():
        return jsonify({"error": "Unauthorized"}), 401
    ensure_user_schema()
    data = request.get_json(silent=True) or {}
    user = User.query.filter_by(id=data.get("id")).first()
    if not user or user.role not in {"staff", "supplier"}:
        return jsonify({"error": "Account not found."}), 404
    user.is_disabled = not user.is_disabled
    db.session.commit()
    return jsonify({"status": "success", "disabled": user.is_disabled})

# Registration is handled by the Manager only.
@app.route("/request-access", methods=["GET", "POST"])
def request_access():
    return redirect("/")

@app.route("/forgot-password")
def forgot_password():
    return redirect("/")

# INVENTORY API
@app.route("/api/inventory")
def get_inventory():
    items = Inventory.query.all()
    return jsonify([inventory_item_payload(i) for i in items])

@app.route("/api/inventory/add", methods=["POST"])
def add_inventory():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    supplier = str(data.get("supplier", "")).strip()
    if not name or not supplier:
        return jsonify({"error": "Ingredient name and supplier are required."}), 400
    if Inventory.query.filter(db.func.lower(Inventory.name) == name.lower()).first():
        return jsonify({"error": "An ingredient with that name already exists."}), 409
    try:
        stock = float(data.get("stock", 0) or 0)
        threshold = float(data.get("threshold", 0) or 0)
        price = float(data.get("price", 150) or 150)
    except (TypeError, ValueError):
        return jsonify({"error": "Enter valid numeric values for stock, threshold, and price."}), 400
    item = Inventory(
        name=name,
        stock=stock,
        threshold=threshold,
        unit=str(data.get("unit", "pcs") or "pcs"),
        supplier_name=supplier,
    )
    db.session.add(item)
    sync_supplier_catalog_price(supplier, name, price)
    db.session.flush()
    check_and_auto_purchase_request(item.id, requested_by="staff")
    db.session.commit()
    return jsonify({"status": "success", "id": item.id})

# --- AUTOMATIC REORDER TRIGGER FUNCTION ---
def check_and_auto_reorder(item_id, requested_by=None):
    """Backward-compatible alias that creates an auto purchase request."""
    return check_and_auto_purchase_request(item_id, requested_by=requested_by)

@app.route("/api/inventory/update", methods=["POST"])
def update_inventory():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data = request.get_json(silent=True) or {}
    item = Inventory.query.get(data.get("id"))
    if not item:
        return jsonify({"status": "error", "message": "Item not found"}), 404
    if "threshold" in data:
        try:
            item.threshold = float(data.get("threshold", item.threshold))
        except (TypeError, ValueError):
            return jsonify({"error": "Enter a valid threshold."}), 400
    if "price" in data:
        try:
            price = float(data.get("price"))
            sync_supplier_catalog_price(item.supplier_name, item.name, price)
        except (TypeError, ValueError):
            return jsonify({"error": "Enter a valid price."}), 400
    if "stock" in data:
        try:
            item.stock = float(data.get("stock", item.stock))
        except (TypeError, ValueError):
            return jsonify({"error": "Enter a valid stock level."}), 400
    db.session.commit()
    check_and_auto_purchase_request(item.id, requested_by="staff")
    db.session.commit()
    return jsonify({"status": "success"})

@app.route("/api/inventory/delete", methods=["POST"])
def delete_inventory():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data = request.get_json(silent=True) or {}
    item = Inventory.query.get(data.get("id"))
    if item:
        supplier = Supplier.query.filter_by(name=item.supplier_name).first()
        if supplier and supplier.catalog:
            try:
                catalog = json.loads(supplier.catalog)
                catalog = [entry for entry in catalog if entry.get("itemName", "").lower() != item.name.lower()]
                supplier.catalog = json.dumps(catalog)
            except (TypeError, json.JSONDecodeError):
                pass
        db.session.delete(item)
        db.session.commit()
    return jsonify({"status": "success"})

@app.route("/api/inventory/update-threshold", methods=["POST"])
def update_threshold():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data = request.get_json(silent=True) or {}
    item = Inventory.query.get(data.get("id"))
    if item:
        try:
            item.threshold = float(data.get("threshold", item.threshold))
        except (TypeError, ValueError):
            return jsonify({"error": "Enter a valid threshold."}), 400
        db.session.commit()
        check_and_auto_purchase_request(item.id, requested_by="staff")
        db.session.commit()
        return jsonify({"status": "success"})
    return jsonify({"status": "error"}), 404

# SUPPLIER API
@app.route("/api/suppliers")
def get_suppliers():
    suppliers=Supplier.query.all()

    return jsonify([
        {
            "id":s.id,
            "name":s.name,
            "email":s.email,
            "phone":s.phone,
            "catalog":json.loads(s.catalog)
        }
        for s in suppliers
    ])

@app.route("/api/suppliers/add",methods=["POST"])
def add_supplier():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data = request.get_json(silent=True) or {}
    catalog = data.get("catalog", [])
    supplier = Supplier(
        name=data["name"],
        email=data.get("email"),
        phone=data.get("phone"),
        catalog=json.dumps(catalog),
    )
    db.session.add(supplier)
    add_catalog_items_to_inventory(data["name"], catalog)
    db.session.commit()
    return jsonify({"status": "success"})

@app.route("/api/suppliers/delete",methods=["POST"])
def delete_supplier():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data=request.json
    supplier=Supplier.query.get(data["id"])

    if supplier:
        db.session.delete(supplier)
        db.session.commit()

    return jsonify({"status":"success"})

# PURCHASE ORDER API
@app.route("/api/purchase-orders")
def get_purchase_orders():
    orders = PurchaseOrder.query.all()
    orders.sort(key=lambda o: (PO_STATUS_PRIORITY.get(o.status, 99), o.id or ""))
    return jsonify([
        {
            "id": o.id,
            "itemName": o.item_name,
            "qty": o.qty,
            "unit": o.unit,
            "supplier": o.supplier,
            "total": o.total,
            "status": o.status,
            "type": o.type,
            "date": o.date
        }
        for o in orders
    ])

@app.route("/api/purchase-orders/create",methods=["POST"])
def create_po():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data=request.json

    po=PurchaseOrder(
        id=data["id"],
        item_name=data["itemName"],
        qty=data["qty"],
        unit=data.get("unit"),
        supplier=data.get("supplier"),
        total=data.get("total",0),
        status="Awaiting approval",
        type=data.get(
            "type",
            "Manual Request"
        ),
        date=datetime.now().strftime('%B %d, %Y')
    )

    db.session.add(po)
    db.session.commit()
    return jsonify({"status":"success"})

@app.route("/api/purchase-orders/approve",methods=["POST"])
def approve_po():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data=request.json
    po=PurchaseOrder.query.get(data["id"])

    if po:
        po.status = "Waiting for Supplier"
        db.session.add(ActivityLog(event="Purchase Order Sent to Supplier", item=po.item_name, reference=po.id, status="Waiting for Supplier", time=datetime.now().strftime("%H:%M")))
        create_notification(
            "supplier",
            po.supplier or "",
            "new_purchase_order",
            "New Purchase Order",
            f"PO {po.id} for {po.item_name} is waiting for your response.",
            po.id,
        )
        db.session.commit()

    return jsonify({"status":"success"})

@app.route("/api/purchase-orders/reject",methods=["POST"])
def reject_po():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data=request.json
    po=PurchaseOrder.query.get(data["id"])

    if po:
        po.status="Rejected"
        db.session.commit()

    return jsonify({"status":"success"})

# ACTIVITY LOG
def activity_log_payload(log):
    return {
        "event": log.event,
        "item": log.item,
        "reference": log.reference,
        "status": log.status,
        "time": log.time,
    }

def get_role_filtered_activity(keywords):
    logs = ActivityLog.query.order_by(ActivityLog.id.desc()).limit(120).all()
    result = []
    for log in logs:
        event = (log.event or "").lower()
        if any(keyword in event for keyword in keywords):
            result.append(activity_log_payload(log))
        if len(result) >= 20:
            break
    return result

@app.route("/api/activity")
def get_activity():
    role = active_portal_role()
    if role == "supplier" and supplier_api_allowed():
        return jsonify(get_supplier_activity_payload())
    if role == "manager" and manager_api_allowed():
        return jsonify(get_role_filtered_activity(MANAGER_ACTIVITY_KEYWORDS))
    if role == "staff" and staff_api_allowed():
        return jsonify(get_role_filtered_activity(STAFF_ACTIVITY_KEYWORDS))
    return jsonify([])

def get_supplier_activity_payload():
    company = get_supplier_company_for_user(portal_username("supplier"))
    if not company:
        return []
    supplier = Supplier.query.filter_by(name=company).first()
    catalog_items = set()
    if supplier and supplier.catalog:
        try:
            catalog_items = {entry.get("itemName", "") for entry in json.loads(supplier.catalog)}
        except (TypeError, json.JSONDecodeError):
            catalog_items = set()
    po_ids = {po.id for po in PurchaseOrder.query.filter_by(supplier=company).all()}
    logs = ActivityLog.query.order_by(ActivityLog.id.desc()).limit(100).all()
    result = []
    for log in logs:
        if log.item == company or log.item in catalog_items or log.reference in po_ids:
            result.append({
                "event": log.event,
                "item": log.item,
                "reference": log.reference,
                "status": log.status,
                "time": log.time,
            })
        elif company.lower() in (log.event or "").lower():
            result.append({
                "event": log.event,
                "item": log.item,
                "reference": log.reference,
                "status": log.status,
                "time": log.time,
            })
    return result[:20]

@app.route("/api/activity/add",methods=["POST"])
def add_activity():
    data=request.json

    log=ActivityLog(
        event=data["event"],
        item=data.get("item"),
        reference=data.get("reference"),
        status=data.get("status"),
        time=datetime.now().strftime("%H:%M")
    )

    db.session.add(log)
    db.session.commit()
    return jsonify({"status":"success"})

def staff_api_allowed():
    if active_portal_role() != "staff":
        return False
    ps = portal_data("staff")
    if not ps.get("username"):
        return False
    if ps.get("password_expired"):
        return False
    return True

@app.route("/api/staff/profile")
def staff_profile():
    if not staff_api_allowed():
        return jsonify({"error": "Your session has expired. Please sign in again."}), 403
    return jsonify({"username": portal_username("staff") or "staff", "role": "Inventory Staff"})

@app.route("/api/staff/adjustments")
def staff_adjustments():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    records = StockAdjustment.query.order_by(StockAdjustment.id.desc()).all()
    return jsonify([{
        "id": record.id,
        "itemId": record.inventory_id,
        "itemName": record.item_name,
        "type": record.adjustment_type,
        "quantity": record.quantity,
        "reason": record.reason,
        "previousStock": record.previous_stock,
        "newStock": record.new_stock,
        "staff": record.staff_username,
        "date": record.date
    } for record in records])

@app.route("/api/staff/adjustments", methods=["POST"])
def create_staff_adjustment():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    data = request.get_json(silent=True) or {}
    item = Inventory.query.get(data.get("itemId"))
    adjustment_type = str(data.get("type", ""))
    reason = str(data.get("reason", "")).strip()
    try:
        quantity = float(data.get("quantity", 0))
    except (TypeError, ValueError):
        quantity = 0
    if not item or adjustment_type not in {"Add", "Deduct", "Damaged", "Expired", "Correction"} or not reason or quantity <= 0:
        return jsonify({"error": "Complete all adjustment fields with a valid quantity."}), 400

    previous_stock = float(item.stock or 0)
    if adjustment_type in {"Add", "Correction"}:
        new_stock = max(0, previous_stock + abs(quantity))
        recorded_quantity = abs(quantity)
    else:
        new_stock = max(0, previous_stock - abs(quantity))
        recorded_quantity = -abs(quantity)

    item.stock = new_stock
    timestamp = datetime.now().strftime("%B %d, %Y · %I:%M %p")
    record = StockAdjustment(
        inventory_id=item.id,
        item_name=item.name,
        adjustment_type=adjustment_type,
        quantity=recorded_quantity,
        reason=reason,
        previous_stock=previous_stock,
        new_stock=new_stock,
        staff_username=portal_username("staff") or "staff",
        date=timestamp
    )
    db.session.add(record)
    db.session.add(ActivityLog(event="Stock Adjustment Recorded", item=item.name, reference=reason, status=adjustment_type, time=datetime.now().strftime("%H:%M")))
    db.session.commit()
    check_and_auto_purchase_request(item.id, requested_by=portal_username("staff") or "staff")
    db.session.commit()
    return jsonify({"status": "success", "newStock": new_stock})

@app.route("/api/staff/deliveries")
def staff_deliveries():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    receipts = {record.po_id: record for record in ReceivingRecord.query.all()}
    orders = PurchaseOrder.query.order_by(PurchaseOrder.id.desc()).all()
    result = []
    for order in orders:
        receipt = receipts.get(order.id)
        if receipt:
            status = receipt.status
            date_received = receipt.date_received
            received_by = receipt.received_by
            received_quantity = receipt.received_quantity
        else:
            status = "Pending" if order.status in {"Transmitted", "Waiting for Supplier", "Accepted"} else order.status
            date_received = "—"
            received_by = "—"
            received_quantity = 0
        result.append({
            "deliveryId": receipt.delivery_id if receipt else delivery_id_for_po(order.id),
            "poNumber": order.id,
            "supplier": order.supplier or "Unassigned Supplier",
            "itemName": order.item_name,
            "expectedQuantity": order.qty,
            "unit": order.unit,
            "status": status,
            "date": order.date,
            "dateReceived": date_received,
            "receivedBy": received_by,
            "receivedQuantity": received_quantity
        })
    return jsonify(result)

@app.route("/api/staff/deliveries/<delivery_id>")
def staff_delivery_detail(delivery_id):
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    order = find_order_for_delivery_lookup(delivery_id)
    if not order:
        return jsonify({"error": "Delivery ID was not found."}), 404
    lookup = parse_delivery_lookup(delivery_id)
    shipment = find_active_shipment(delivery_id=lookup, po_id=order.id)
    success = successful_receipt_for_po(order.id)
    rejected = ReceivingRecord.query.filter_by(po_id=order.id, status="Rejected").order_by(
        ReceivingRecord.id.desc()
    ).first()
    pending_statuses = {"Transmitted", "Waiting for Supplier", "Accepted", "In Transit"}
    if success:
        display_id = success.delivery_id
        status = success.status
        already_received = True
    elif shipment:
        display_id = shipment.qr_value
        status = shipment.status
        already_received = False
    elif rejected:
        display_id = active_delivery_id_for_po(order.id)
        status = rejected.status
        already_received = False
    else:
        display_id = delivery_id_for_po(order.id)
        status = order.status if order.status in pending_statuses else order.status or "Pending"
        already_received = False
    supplier_profile = Supplier.query.filter_by(name=order.supplier).first()
    return jsonify({
        "deliveryId": display_id,
        "poNumber": order.id,
        "supplier": order.supplier or "Unassigned Supplier",
        "supplierId": order.supplier_id or "",
        "itemName": order.item_name,
        "expectedQuantity": order.qty,
        "unit": order.unit,
        "status": status,
        "orderStatus": order.status,
        "expectedDeliveryDate": order.expected_delivery_date or order.date,
        "orderDate": order.date,
        "total": order.total,
        "items": [{
            "itemName": order.item_name,
            "quantity": order.qty,
            "unit": order.unit,
        }],
        "alreadyReceived": already_received,
        "scanSuccess": True,
        "supplierEmail": supplier_profile.email if supplier_profile else "",
        "supplierPhone": supplier_profile.phone if supplier_profile else "",
    })

@app.route("/api/staff/deliveries/confirm", methods=["POST"])
def confirm_staff_delivery():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    data = request.get_json(silent=True) or {}
    order = PurchaseOrder.query.get(data.get("poNumber"))
    if not order:
        return jsonify({"error": "Purchase order was not found."}), 404
    if successful_receipt_for_po(order.id):
        return jsonify({"error": "This delivery has already been recorded."}), 409
    lookup = parse_delivery_lookup(data.get("deliveryId") or "")
    shipment = find_active_shipment(delivery_id=lookup, po_id=order.id)
    if lookup:
        prior = ReceivingRecord.query.filter(
            db.func.lower(ReceivingRecord.delivery_id) == lookup.lower()
        ).first()
        if prior and prior.status in {"Delivered", "Partial"}:
            return jsonify({"error": "This delivery has already been recorded."}), 409
        delivery_id = lookup
    elif shipment:
        delivery_id = shipment.qr_value
    else:
        if ReceivingRecord.query.filter_by(po_id=order.id).filter(
            ReceivingRecord.status.in_(["Delivered", "Partial"])
        ).first():
            return jsonify({"error": "This delivery has already been recorded."}), 409
        delivery_id = delivery_id_for_po(order.id)
    if ReceivingRecord.query.filter_by(delivery_id=delivery_id).first():
        delivery_id = new_delivery_id_for_po(order.id)
    try:
        received_quantity = float(data.get("receivedQuantity", 0))
    except (TypeError, ValueError):
        received_quantity = 0
    condition = str(data.get("condition", ""))
    decision = str(data.get("decision", ""))
    rejection_reason = str(data.get("rejectionReason", "")).strip()
    status_map = {"complete": "Delivered", "partial": "Partial", "reject": "Rejected"}
    if decision not in status_map or condition not in {"Good Condition", "Damaged", "Partial Delivery"}:
        return jsonify({"error": "Select the item condition and receiving decision."}), 400
    if decision == "reject" and not rejection_reason:
        return jsonify({"error": "Enter a rejection reason."}), 400
    if decision != "reject" and received_quantity <= 0:
        return jsonify({"error": "Enter the quantity received."}), 400

    status = status_map[decision]
    item = None
    if decision == "reject":
        received_quantity = 0
    else:
        item = Inventory.query.filter(db.func.lower(Inventory.name) == order.item_name.lower()).first()
        if item:
            item.stock = float(item.stock or 0) + received_quantity

    timestamp = datetime.now().strftime("%B %d, %Y · %I:%M %p")
    staff_user = portal_username("staff") or "staff"
    receipt = ReceivingRecord(
        delivery_id=delivery_id,
        po_id=order.id,
        supplier=order.supplier or "Unassigned Supplier",
        item_name=order.item_name,
        expected_quantity=float(order.qty or 0),
        received_quantity=received_quantity,
        condition=condition,
        status=status,
        received_by=staff_user,
        date_received=timestamp,
        rejection_reason=rejection_reason if decision == "reject" else None,
        resolution_status="Open" if decision == "reject" else None,
    )
    order.status = status
    db.session.add(receipt)
    if shipment:
        shipment.status = status
    else:
        db.session.add(DeliveryRecord(qr_value=delivery_id, po_id=order.id, status=status, time=datetime.now().strftime("%H:%M")))
    if status in {"Delivered", "Partial"}:
        for resolution in DeliveryResolution.query.filter_by(po_id=order.id).filter(
            DeliveryResolution.status.in_(["In Progress", "Open", "Pending Manager Review", "Approved"])
        ).all():
            if resolution.action in {"Redelivery", "Replace Item", "Contact Manager"}:
                resolution.status = "Completed"
                resolution.updated_at = datetime.now()
    db.session.add(ActivityLog(event="Delivery Received" if status != "Rejected" else "Delivery Rejected", item=order.item_name, reference=delivery_id, status=status, time=datetime.now().strftime("%H:%M")))
    create_notification(
        "manager",
        "manager",
        "delivery_verified",
        "Delivery Verified",
        f"{staff_user} recorded {status} for {order.item_name} ({delivery_id}).",
        delivery_id,
    )
    if status == "Rejected":
        create_notification(
            "supplier",
            order.supplier or "",
            "delivery_rejected",
            "Delivery Rejected",
            f"Delivery {delivery_id} for PO {order.id} was rejected. Open Delivery History to choose a resolution.",
            delivery_id,
        )
    else:
        create_notification(
            "supplier",
            order.supplier or "",
            "delivery_verified",
            "Delivery Verified",
            f"Delivery {delivery_id} for PO {order.id} was marked {status}.",
            delivery_id,
        )
    db.session.commit()
    message = "Delivery verified and successfully delivered." if status == "Delivered" else f"Delivery recorded as {status}."
    return jsonify({"status": "success", "deliveryStatus": status, "message": message, "newStock": float(item.stock or 0) if item else None})

# READ-ONLY MANAGER DELIVERY MONITORING
@app.route("/api/deliveries")
def get_deliveries():
    if not manager_api_allowed():
        return jsonify({"error": "Unauthorized"}), 401

    receipts_by_po = {record.po_id: record for record in ReceivingRecord.query.all()}
    orders = PurchaseOrder.query.order_by(PurchaseOrder.date.desc(), PurchaseOrder.id.desc()).all()
    deliveries = []

    for index, order in enumerate(orders, start=1):
        receipt = receipts_by_po.get(order.id)
        if receipt:
            status = receipt.status
            delivery_id = receipt.delivery_id
            received_by = receipt.received_by
            delivery_date = receipt.date_received
        else:
            status = {
                "Transmitted": "In Transit",
                "Rejected": "Rejected",
                "Awaiting approval": "In Preparation"
            }.get(order.status, order.status or "In Preparation")
            delivery_id = f"DEL-{index:03d}"
            received_by = "—"
            delivery_date = order.date or datetime.now().strftime("%B %d, %Y")

        deliveries.append({
            "id": delivery_id,
            "supplier": order.supplier or "Unassigned Supplier",
            "poNumber": order.id,
            "status": status,
            "date": delivery_date,
            "receivedBy": received_by
        })

    return jsonify(deliveries)

# INVENTORY STAFF DELIVERY VERIFICATION
@app.route("/api/delivery/save",methods=["POST"])
def save_delivery():
    return jsonify({"error": "Use the Inventory Staff verification workflow before confirming receipt."}), 410

@app.route("/api/profile", methods=["GET", "POST"])
def api_profile():
    role = active_portal_role()
    if role not in {"manager", "staff", "supplier"}:
        return jsonify({"error": "Unauthorized"}), 401
    if role == "manager" and not manager_api_allowed() and not portal_data("manager").get("authenticated"):
        return jsonify({"error": "Unauthorized"}), 401
    if role == "staff" and not portal_data("staff").get("username"):
        return jsonify({"error": "Unauthorized"}), 401
    if role == "supplier" and not portal_data("supplier").get("username"):
        return jsonify({"error": "Unauthorized"}), 401
    username = portal_username(role)
    if request.method == "GET":
        return jsonify(profile_payload(role, username))
    data = request.get_json(silent=True) or {}
    if role == "manager":
        profile = ManagerProfile.query.filter_by(username=username).first() or ManagerProfile(username=username)
        profile.full_name = str(data.get("fullName", profile.full_name or "")).strip()
        profile.email = str(data.get("email", profile.email or "")).strip()
        profile.contact_number = str(data.get("contactNumber", profile.contact_number or "")).strip()
        if "avatarData" in data:
            profile.avatar_data = data.get("avatarData") or ""
        db.session.add(profile)
    else:
        user = User.query.filter_by(username=username, role=role).first()
        profile = UserProfile.query.filter_by(user_id=user.id).first() or UserProfile(user_id=user.id)
        if role == "staff":
            profile.full_name = str(data.get("fullName", profile.full_name or "")).strip()
            profile.email = str(data.get("email", profile.email or "")).strip()
            profile.contact_number = str(data.get("contactNumber", profile.contact_number or "")).strip()
            if "avatarData" in data:
                profile.avatar_data = data.get("avatarData") or ""
        else:
            profile.company_name = str(data.get("companyName", profile.company_name or "")).strip()
            profile.contact_person = str(data.get("contactPerson", profile.contact_person or "")).strip()
            profile.email = str(data.get("email", profile.email or "")).strip()
            profile.contact_number = str(data.get("contactNumber", profile.contact_number or "")).strip()
            profile.business_address = str(data.get("businessAddress", profile.business_address or "")).strip()
            if "logoData" in data:
                profile.logo_data = data.get("logoData") or ""
        db.session.add(profile)
    db.session.commit()
    return jsonify({"status": "success", "profile": profile_payload(role, username)})

@app.route("/api/purchase-requests")
def get_purchase_requests():
    role = active_portal_role()
    if role == "staff":
        if not staff_api_allowed():
            return jsonify({"error": "Unauthorized"}), 403
        staff_user = portal_username("staff")
        requests_list = PurchaseRequest.query.filter_by(requested_by=staff_user).all()
    elif manager_api_allowed():
        requests_list = PurchaseRequest.query.all()
    else:
        return jsonify({"error": "Unauthorized"}), 401
    requests_list.sort(key=purchase_request_sort_key)
    return jsonify([purchase_request_payload(r) for r in requests_list])

@app.route("/api/purchase-requests", methods=["POST"])
def create_purchase_request():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    data = request.get_json(silent=True) or {}
    item_name = str(data.get("itemName", "")).strip()
    supplier_name = str(data.get("supplierName", "")).strip()
    try:
        qty = float(data.get("qty", 0))
    except (TypeError, ValueError):
        qty = 0
    if not item_name or qty <= 0:
        return jsonify({"error": "Item name and quantity are required."}), 400
    item = Inventory.query.filter(db.func.lower(Inventory.name) == item_name.lower()).first()
    if not supplier_name and item:
        supplier_name = item.supplier_name or ""
    if not supplier_name:
        return jsonify({"error": "Select a supplier for this purchase request."}), 400
    req_id = f"PR-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    submitted_at = current_local_datetime()
    record = PurchaseRequest(
        id=req_id,
        item_name=item_name,
        qty=qty,
        unit=data.get("unit", "pcs"),
        reason=str(data.get("reason", "")).strip(),
        requested_by=portal_username("staff") or "staff",
        supplier_name=supplier_name,
        status="Pending",
        date=format_pr_datetime(submitted_at),
        created_at=submitted_at,
    )
    db.session.add(record)
    db.session.add(ActivityLog(event="Purchase Request submitted", item=item_name, reference=req_id, status="Pending", time=datetime.now().strftime("%H:%M")))
    create_notification(
        "manager",
        "manager",
        "new_purchase_request",
        "New Purchase Request",
        f"{portal_username('staff') or 'staff'} requested {item_name} ({qty} {record.unit}) from {supplier_name}.",
        req_id,
    )
    db.session.commit()
    return jsonify({"status": "success", "id": req_id})

@app.route("/api/purchase-requests/review", methods=["POST"])
def review_purchase_request():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data = request.get_json(silent=True) or {}
    record = PurchaseRequest.query.get(data.get("id"))
    action = str(data.get("action", "")).lower()
    if not record or action not in {"approve", "reject"}:
        return jsonify({"error": "Invalid request review action."}), 400
    record.status = "Approved" if action == "approve" else "Rejected"
    record.review_note = str(data.get("note", "")).strip()
    po_id = None
    if action == "approve":
        po = create_po_from_purchase_request(record)
        po_id = po.id
        create_notification(
            "staff",
            record.requested_by,
            "purchase_request_approved",
            "Purchase Request Approved",
            f"Your request {record.id} for {record.item_name} was approved. PO {po_id} sent to {po.supplier}.",
            record.id,
        )
    else:
        create_notification(
            "staff",
            record.requested_by,
            "purchase_request_rejected",
            "Purchase Request Rejected",
            f"Your request {record.id} for {record.item_name} was rejected.",
            record.id,
        )
    db.session.add(ActivityLog(event=f"Purchase Request {record.status}", item=record.item_name, reference=record.id, status=record.status, time=datetime.now().strftime("%H:%M")))
    db.session.commit()
    return jsonify({"status": "success", "poId": po_id})

@app.route("/api/support", methods=["GET", "POST"])
def api_support():
    role = active_portal_role()
    if role not in {"staff", "supplier"} and not manager_api_allowed():
        return jsonify({"error": "Unauthorized"}), 401
    if request.method == "GET":
        if manager_api_allowed():
            tickets = SupportRequest.query.order_by(SupportRequest.id.desc()).all()
        else:
            username = portal_username(role)
            tickets = SupportRequest.query.filter_by(username=username, role=role).order_by(SupportRequest.id.desc()).all()
        return jsonify([{
            "id": t.id,
            "ticketId": t.ticket_id,
            "username": t.username,
            "role": t.role,
            "category": t.category,
            "subject": t.subject,
            "message": t.message,
            "status": t.status,
            "date": t.date,
        } for t in tickets])
    if role not in {"staff", "supplier"}:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    category = str(data.get("category", "")).strip()
    subject = str(data.get("subject", "")).strip()
    message = str(data.get("message", "")).strip()
    if category not in {"Account Issue", "Password Concern", "Purchase Order Concern", "Delivery Concern", "Other"} or not subject or not message:
        return jsonify({"error": "Complete all support request fields."}), 400
    ticket_id = f"TKT-{datetime.now().strftime('%Y%m%d%H%M')}"
    ticket = SupportRequest(
        ticket_id=ticket_id,
        username=portal_username(role),
        role=role,
        category=category,
        subject=subject,
        message=message,
        status="Open",
        date=datetime.now().strftime("%B %d, %Y · %I:%M %p"),
    )
    db.session.add(ticket)
    db.session.add(ActivityLog(event="Support Request submitted", item=category, reference=ticket_id, status="Open", time=datetime.now().strftime("%H:%M")))
    create_notification(
        "manager",
        "manager",
        "support_request",
        "New Support Request",
        f"{portal_username(role)} submitted support ticket {ticket_id}: {subject}",
        ticket_id,
    )
    db.session.commit()
    return jsonify({"status": "success", "ticketId": ticket_id})

@app.route("/api/support/update", methods=["POST"])
def update_support_request():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data = request.get_json(silent=True) or {}
    ticket = SupportRequest.query.get(data.get("id"))
    status = str(data.get("status", "")).strip()
    if not ticket or status not in {"Open", "In Progress", "Resolved", "Closed"}:
        return jsonify({"error": "Invalid support ticket update."}), 400
    ticket.status = status
    create_notification(
        ticket.role,
        ticket.username,
        "support_status_updated",
        "Support Ticket Updated",
        f"Ticket {ticket.ticket_id} status changed to {status}.",
        ticket.ticket_id,
    )
    db.session.commit()
    return jsonify({"status": "success"})

@app.route("/api/supplier/purchase-orders")
def supplier_purchase_orders():
    if not supplier_api_allowed():
        return jsonify({"error": "Supplier access required"}), 403
    orders = purchase_orders_for_supplier(portal_username("supplier"))
    return jsonify([{
        "id": o.id,
        "itemName": o.item_name,
        "qty": o.qty,
        "unit": o.unit,
        "supplier": o.supplier,
        "supplierId": o.supplier_id or "",
        "total": o.total,
        "status": o.status,
        "type": o.type,
        "date": o.date,
        "expectedDeliveryDate": o.expected_delivery_date or "—",
        "deliveryId": active_delivery_id_for_po(o.id),
    } for o in orders])

@app.route("/api/delivery-resolutions")
def get_delivery_resolutions():
    if not manager_api_allowed():
        return jsonify({"error": "Unauthorized"}), 401
    records = DeliveryResolution.query.order_by(DeliveryResolution.id.desc()).all()
    return jsonify([resolution_payload(r) for r in records])

@app.route("/api/delivery-resolutions/update", methods=["POST"])
def update_delivery_resolution():
    if not manager_api_allowed():
        return jsonify({"error": "Manager access required"}), 403
    data = request.get_json(silent=True) or {}
    record = DeliveryResolution.query.get(data.get("id"))
    status = str(data.get("status", "")).strip()
    allowed = {
        "Pending Manager Review", "Approved", "Rejected", "Completed", "Reopened",
        "Open", "In Progress", "Refund Pending", "Refund in Progress", "Closed", "Resolved",
    }
    if not record or status not in allowed:
        return jsonify({"error": "Invalid resolution update."}), 400
    record.status = normalize_resolution_status(status) if status in {
        "Open", "In Progress", "Refund Pending", "Refund in Progress", "Closed", "Resolved",
    } else status
    record.manager_note = str(data.get("note", record.manager_note or "")).strip()
    record.updated_at = datetime.now()
    if record.action == "Refund" and record.status in {"Completed", "Closed", "Resolved"}:
        po = PurchaseOrder.query.get(record.po_id)
        if po:
            po.status = "Refund Resolved"
    feedback_at = record.updated_at.strftime("%B %d, %Y · %I:%M %p")
    note_text = record.manager_note or "No remarks provided."
    create_notification(
        "supplier",
        record.supplier,
        "delivery_resolution_update",
        "Delivery Resolution Updated",
        f"Manager set {record.resolution_id} to {record.status}. Remarks: {note_text} · {feedback_at}",
        record.resolution_id,
    )
    db.session.commit()
    return jsonify({"status": "success"})

@app.route("/api/supplier/purchase-orders/respond", methods=["POST"])
def supplier_respond_po():
    if not supplier_api_allowed():
        return jsonify({"error": "Supplier access required"}), 403
    data = request.get_json(silent=True) or {}
    po = PurchaseOrder.query.get(data.get("id"))
    action = str(data.get("action", "")).lower()
    company = get_supplier_company_for_user(portal_username("supplier"))
    if not po or not supplier_matches_company(po.supplier, company) or action not in {"accept", "reject"}:
        return jsonify({"error": "Purchase order not found or not assigned to your company."}), 404
    po.status = "Accepted" if action == "accept" else "Rejected by Supplier"
    event = "Purchase Order accepted" if action == "accept" else "Purchase Order rejected"
    db.session.add(ActivityLog(event=event, item=po.item_name, reference=po.id, status=po.status, time=datetime.now().strftime("%H:%M")))
    create_notification(
        "manager",
        "manager",
        "purchase_order_accepted" if action == "accept" else "purchase_order_rejected",
        "Purchase Order " + ("Accepted" if action == "accept" else "Rejected"),
        f"{company} {'accepted' if action == 'accept' else 'rejected'} PO {po.id} for {po.item_name}.",
        po.id,
    )
    db.session.commit()
    return jsonify({"status": "success", "deliveryId": delivery_id_for_po(po.id)})

@app.route("/api/supplier/purchase-orders/generate-qr", methods=["POST"])
def supplier_generate_qr():
    if not supplier_api_allowed():
        return jsonify({"error": "Supplier access required"}), 403
    data = request.get_json(silent=True) or {}
    po = PurchaseOrder.query.get(data.get("id"))
    company = get_supplier_company_for_user(portal_username("supplier"))
    if not po or not supplier_matches_company(po.supplier, company):
        return jsonify({"error": "Purchase order not found or not assigned to your company."}), 404
    open_redelivery = DeliveryResolution.query.filter_by(po_id=po.id).filter(
        DeliveryResolution.action.in_(["Redelivery", "Replace Item"]),
        DeliveryResolution.status.in_(["In Progress", "Open", "Pending Manager Review", "Approved", "Reopened"]),
    ).first()
    if po.status not in {"Accepted", "In Transit"} and not open_redelivery:
        return jsonify({"error": "Generate a QR code only after accepting the purchase order or starting a redelivery."}), 400
    shipment = find_active_shipment(po_id=po.id)
    delivery_id = shipment.qr_value if shipment else active_delivery_id_for_po(po.id)
    if po.status == "Accepted":
        po.status = "In Transit"
    existing = DeliveryRecord.query.filter_by(po_id=po.id, qr_value=delivery_id).first()
    if not existing:
        db.session.add(DeliveryRecord(
            qr_value=delivery_id,
            po_id=po.id,
            status="QR Generated",
            time=datetime.now().strftime("%H:%M"),
            resolution_id=open_redelivery.resolution_id if open_redelivery else None,
        ))
    elif existing.status in ACTIVE_SHIPMENT_STATUSES:
        existing.status = "QR Generated"
    db.session.add(ActivityLog(
        event="Delivery QR Generated",
        item=po.item_name,
        reference=delivery_id,
        status="QR Generated",
        time=datetime.now().strftime("%H:%M"),
    ))
    create_notification(
        "staff",
        "staff",
        "delivery_qr_generated",
        "Delivery QR Generated",
        f"{company} generated QR {delivery_id} for PO {po.id} ({po.item_name}).",
        delivery_id,
    )
    db.session.commit()
    return jsonify({
        "status": "success",
        "deliveryId": delivery_id,
        "poId": po.id,
        "qrValue": delivery_id,
        "itemName": po.item_name,
        "qty": po.qty,
        "unit": po.unit,
        "expectedDeliveryDate": po.expected_delivery_date or po.date,
    })

@app.route("/api/supplier/deliveries")
def supplier_deliveries():
    if not supplier_api_allowed():
        return jsonify({"error": "Supplier access required"}), 403
    orders = purchase_orders_for_supplier(portal_username("supplier"))
    receipts = {r.po_id: r for r in ReceivingRecord.query.all()}
    visible_statuses = {
        "Accepted", "In Transit", "Delivered", "Partial", "Waiting for Supplier",
        "Rejected", "Rejected by Supplier",
    }
    result = []
    for o in orders:
        receipt = receipts.get(o.id)
        rejected_receipt = ReceivingRecord.query.filter_by(po_id=o.id, status="Rejected").order_by(
            ReceivingRecord.id.desc()
        ).first()
        shipment = find_active_shipment(po_id=o.id)
        open_resolution = DeliveryResolution.query.filter_by(po_id=o.id).order_by(
            DeliveryResolution.id.desc()
        ).first()
        status = receipt.status if receipt else o.status
        if shipment:
            status = shipment.status or status
        include = bool(receipt) or o.status in visible_statuses or (status or "").lower() == "rejected"
        if shipment and not receipt:
            include = True
        if rejected_receipt:
            include = True
        if include:
            if receipt and receipt.status in {"Delivered", "Partial"}:
                display_id = receipt.delivery_id
            elif open_resolution and open_resolution.new_delivery_id:
                display_id = open_resolution.new_delivery_id
            elif receipt:
                display_id = receipt.delivery_id
            else:
                display_id = active_delivery_id_for_po(o.id)
            resolved = open_resolution and normalize_resolution_status(open_resolution.status) in {"Completed", "Rejected"}
            needs_resolution = bool(rejected_receipt) and not successful_receipt_for_po(o.id) and not resolved
            if open_resolution and normalize_resolution_status(open_resolution.status) == "Reopened":
                needs_resolution = bool(rejected_receipt) and not successful_receipt_for_po(o.id)
            fields = supplier_resolution_fields(open_resolution)
            result.append({
                "deliveryId": display_id,
                "poNumber": o.id,
                "itemName": o.item_name,
                "qty": o.qty,
                "unit": o.unit,
                "status": status,
                "date": receipt.date_received if receipt else o.date,
                "rejectionReason": rejected_receipt.rejection_reason if rejected_receipt else "",
                "resolutionAction": (open_resolution.action if open_resolution else None) or (receipt.resolution_action if receipt else ""),
                "resolutionStatus": (open_resolution.status if open_resolution else None) or (receipt.resolution_status if receipt else ""),
                "supplierResolutionStatus": fields["supplierResolutionStatus"],
                "managerNote": fields["managerNote"],
                "managerUpdatedAt": fields["managerUpdatedAt"],
                "resolutionLocked": fields["resolutionLocked"],
                "resolutionId": fields["resolutionId"],
                "needsResolution": needs_resolution,
            })
    return jsonify(result)

@app.route("/api/supplier/deliveries/resolve", methods=["POST"])
def supplier_resolve_delivery():
    if not supplier_api_allowed():
        return jsonify({"error": "Supplier access required"}), 403
    data = request.get_json(silent=True) or {}
    action = str(data.get("action", "")).strip()
    if action not in {"Redelivery", "Replace Item", "Refund", "Contact Manager"}:
        return jsonify({"error": "Select a valid resolution action."}), 400
    delivery_id = str(data.get("deliveryId", "")).strip()
    po_number = str(data.get("poNumber", "")).strip()
    company = get_supplier_company_for_user(portal_username("supplier"))
    receipt = find_receiving_for_resolution(delivery_id, po_number)
    po = PurchaseOrder.query.get(po_number or (receipt.po_id if receipt else ""))
    if not po and delivery_id.upper().startswith("PO-"):
        po = PurchaseOrder.query.get(delivery_id)
    if not po or not supplier_matches_company(po.supplier, company):
        return jsonify({"error": "Delivery record not found."}), 404
    if receipt and receipt.status != "Rejected" and action in {"Redelivery", "Replace Item", "Refund"}:
        return jsonify({"error": "Resolution is only available for rejected deliveries."}), 400

    existing = DeliveryResolution.query.filter_by(po_id=po.id).order_by(DeliveryResolution.id.desc()).first()
    if existing and resolution_is_locked(existing):
        return jsonify({"error": "A resolution request is already pending manager review."}), 409

    resolution_id = f"RES-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    new_delivery_id = None
    status = "Pending Manager Review"
    if action == "Refund":
        pass
    elif action in {"Redelivery", "Replace Item"}:
        new_delivery_id = new_delivery_id_for_po(po.id)
        shipment_status = "Pending Redelivery" if action == "Redelivery" else "Pending Replacement"
        po.status = "In Transit"
        db.session.add(DeliveryRecord(
            qr_value=new_delivery_id,
            po_id=po.id,
            status=shipment_status,
            time=datetime.now().strftime("%H:%M"),
            resolution_id=resolution_id,
        ))

    if existing and normalize_resolution_status(existing.status) == "Reopened":
        resolution = existing
        resolution.resolution_id = resolution_id
        resolution.original_delivery_id = receipt.delivery_id if receipt else delivery_id_for_po(po.id)
        resolution.new_delivery_id = new_delivery_id
        resolution.action = action
        resolution.status = status
        resolution.rejection_reason = receipt.rejection_reason if receipt else resolution.rejection_reason
        resolution.updated_at = datetime.now()
    else:
        resolution = DeliveryResolution(
            resolution_id=resolution_id,
            po_id=po.id,
            original_delivery_id=receipt.delivery_id if receipt else delivery_id_for_po(po.id),
            new_delivery_id=new_delivery_id,
            supplier=company,
            item_name=po.item_name,
            quantity=float(po.qty or 0),
            unit=po.unit,
            action=action,
            status=status,
            rejection_reason=receipt.rejection_reason if receipt else "",
        )
        db.session.add(resolution)
    if receipt:
        receipt.resolution_action = action
        receipt.resolution_status = status
    create_notification(
        "manager",
        "manager",
        "delivery_resolution",
        "Supplier Delivery Resolution",
        f"{company} requested {action} for PO {po.id} ({resolution_id}).",
        resolution_id,
    )
    db.session.commit()
    return jsonify({
        "status": "success",
        "resolutionId": resolution_id,
        "newDeliveryId": new_delivery_id,
        "resolutionStatus": status,
    })

@app.route("/api/supplier/catalog", methods=["GET", "POST"])
def supplier_catalog_api():
    if not supplier_api_allowed():
        return jsonify({"error": "Supplier access required"}), 403
    company = get_supplier_company_for_user(portal_username("supplier"))
    supplier = Supplier.query.filter_by(name=company).first()
    if not supplier:
        return jsonify({"error": "Supplier catalog not found."}), 404
    if request.method == "GET":
        try:
            catalog = json.loads(supplier.catalog or "[]")
        except (TypeError, json.JSONDecodeError):
            catalog = []
        return jsonify({"companyName": company, "catalog": catalog})
    data = request.get_json(silent=True) or {}
    updates = data.get("catalog") or []
    if not updates:
        return jsonify({"error": "No catalog updates provided."}), 400
    try:
        catalog = json.loads(supplier.catalog or "[]")
    except (TypeError, json.JSONDecodeError):
        catalog = []
    changed_items = []
    for update in updates:
        item_name = str(update.get("itemName", "")).strip()
        if not item_name:
            continue
        try:
            new_price = float(update.get("price"))
        except (TypeError, ValueError):
            continue
        old_price = None
        found = False
        for entry in catalog:
            if entry.get("itemName", "").lower() == item_name.lower():
                old_price = float(entry.get("price", 0))
                if old_price != new_price:
                    entry["price"] = new_price
                    changed_items.append((item_name, old_price, new_price))
                found = True
                break
        if not found:
            catalog.append({"itemName": item_name, "price": new_price})
            changed_items.append((item_name, None, new_price))
    supplier.catalog = json.dumps(catalog)
    for item_name, old_price, new_price in changed_items:
        sync_supplier_catalog_price(company, item_name, new_price)
        note = f"{item_name}: ₱{old_price:.2f} → ₱{new_price:.2f}" if old_price is not None else f"{item_name}: ₱{new_price:.2f}"
        db.session.add(ActivityLog(
            event="Supplier Price Updated",
            item=company,
            reference=note,
            status="Updated",
            time=datetime.now().strftime("%H:%M"),
        ))
    if changed_items:
        summary = ", ".join(item_name for item_name, _, _ in changed_items[:3])
        if len(changed_items) > 3:
            summary += f" and {len(changed_items) - 3} more"
        create_notification(
            "manager",
            "manager",
            "supplier_price_updated",
            "Supplier Price Updated",
            f"{company} updated pricing for {summary}.",
            company,
        )
    db.session.commit()
    return jsonify({"status": "success", "changed": len(changed_items), "catalog": catalog})

@app.route("/api/dashboard/manager")
def manager_dashboard():
    if not manager_api_allowed():
        return jsonify({"error": "Unauthorized"}), 401
    inventory = Inventory.query.all()
    low_stock = [i for i in inventory if float(i.stock or 0) <= float(i.threshold or 0)]
    out_of_stock = [i for i in inventory if float(i.stock or 0) <= 0]
    pos = PurchaseOrder.query.all()
    prs = PurchaseRequest.query.all()
    receipts_by_po = {record.po_id: record for record in ReceivingRecord.query.all()}
    delivery_statuses = []
    for order in pos:
        receipt = receipts_by_po.get(order.id)
        if receipt:
            delivery_statuses.append(receipt.status)
        else:
            delivery_statuses.append({
                "Transmitted": "In Transit",
                "Waiting for Supplier": "In Preparation",
                "Accepted": "In Transit",
                "Rejected": "Rejected",
                "Awaiting approval": "In Preparation",
            }.get(order.status, order.status or "In Preparation"))
    suppliers = Supplier.query.count()
    support_open = SupportRequest.query.filter(SupportRequest.status.in_(["Open", "In Progress"])).count()
    return jsonify({
        "totalInventory": len(inventory),
        "lowStock": len(low_stock),
        "outOfStock": len(out_of_stock),
        "pendingPurchaseRequests": len([r for r in prs if r.status == "Pending"]),
        "pendingPurchaseOrders": len([p for p in pos if p.status == "Awaiting approval"]),
        "activeSuppliers": suppliers,
        "pendingDeliveries": len([s for s in delivery_statuses if s in {"In Transit", "In Preparation", "Waiting for Supplier", "Accepted", "Pending"}]),
        "completedDeliveries": len([s for s in delivery_statuses if s in {"Delivered", "Partial"}]),
        "openSupportTickets": support_open,
        "purchaseRequestSummary": {
            "pending": len([r for r in prs if r.status == "Pending"]),
            "approved": len([r for r in prs if r.status == "Approved"]),
            "rejected": len([r for r in prs if r.status == "Rejected"]),
        },
        "purchaseOrderSummary": {
            "waiting": len([p for p in pos if p.status in {"Waiting for Supplier", "Transmitted"}]),
            "accepted": len([p for p in pos if p.status == "Accepted"]),
            "rejected": len([p for p in pos if "Rejected" in (p.status or "")]),
            "completed": len([p for p in pos if p.status in {"Delivered", "Partial"}]),
        },
    })

@app.route("/api/dashboard/supplier")
def supplier_dashboard():
    if not supplier_api_allowed():
        return jsonify({"error": "Supplier access required"}), 403
    orders = purchase_orders_for_supplier(portal_username("supplier"))
    return jsonify({
        "newOrders": len([o for o in orders if o.status in {"Waiting for Supplier", "Transmitted"}]),
        "acceptedOrders": len([o for o in orders if o.status == "Accepted"]),
        "pendingDeliveries": len([o for o in orders if o.status in {"Accepted", "In Transit"}]),
        "completedDeliveries": len([o for o in orders if o.status in {"Delivered", "Partial"}]),
        "rejectedOrders": len([o for o in orders if "Rejected" in (o.status or "")]),
        "profile": profile_payload("supplier", portal_username("supplier")),
    })

def current_notification_scope():
    role = active_portal_role()
    if role == "manager" and manager_api_allowed():
        return "manager", "manager"
    if role == "staff" and staff_api_allowed():
        return "staff", portal_username("staff") or ""
    if role == "supplier" and supplier_api_allowed():
        return "supplier", notification_recipient_key("supplier", portal_username("supplier"))
    return None, None

@app.route("/api/notifications")
def get_notifications():
    role, recipient_key = current_notification_scope()
    if not role:
        return jsonify({"error": "Unauthorized"}), 401
    notes = Notification.query.filter_by(
        recipient_role=role,
        recipient_key=recipient_key,
    ).order_by(Notification.id.desc()).limit(50).all()
    unread = Notification.query.filter_by(
        recipient_role=role,
        recipient_key=recipient_key,
        is_read=False,
    ).count()
    return jsonify({
        "unreadCount": unread,
        "items": [{
            "id": note.id,
            "eventType": note.event_type,
            "title": note.title,
            "message": note.message,
            "reference": note.reference,
            "isRead": note.is_read,
            "time": note.created_at.strftime("%I:%M %p") if note.created_at else "",
            "date": note.created_at.strftime("%B %d, %Y") if note.created_at else "",
        } for note in notes],
    })

@app.route("/api/notifications/mark-read", methods=["POST"])
def mark_notification_read():
    role, recipient_key = current_notification_scope()
    if not role:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    note = Notification.query.get(data.get("id"))
    if note and note.recipient_role == role and note.recipient_key == recipient_key:
        note.is_read = True
        db.session.commit()
    return jsonify({"status": "success"})

@app.route("/api/notifications/mark-all-read", methods=["POST"])
def mark_all_notifications_read():
    role, recipient_key = current_notification_scope()
    if not role:
        return jsonify({"error": "Unauthorized"}), 401
    Notification.query.filter_by(
        recipient_role=role,
        recipient_key=recipient_key,
        is_read=False,
    ).update({"is_read": True})
    db.session.commit()
    return jsonify({"status": "success"})

def seed_supplier_account(company_name, supplier_id, contact_person, email, phone, address, password="Supplier@2026"):
    if User.query.filter_by(username=company_name, role="supplier").first():
        return
    supplier_user = User(
        username=company_name,
        password_hash=generate_password_hash(password),
        role="supplier",
        password_changed_at=datetime.now(),
    )
    db.session.add(supplier_user)
    db.session.flush()
    db.session.add(UserProfile(
        user_id=supplier_user.id,
        supplier_id=supplier_id,
        company_name=company_name,
        contact_person=contact_person,
        email=email,
        contact_number=phone,
        business_address=address,
    ))

def initialize_app():
    with app.app_context():
        ensure_user_schema()
        seed_demo_data()
        sync_low_stock_alerts()
        if not User.query.filter_by(username="staff").first():
            db.session.add(User(
                username="staff",
                password_hash=generate_password_hash("123"),
                role="staff",
                password_changed_at=None
            ))
        seed_supplier_account(
            "Metro Meats Supply", "SUP-0001", "Juan Dela Cruz",
            "orders@metromeats.ph", "+63 917 555 0101", "123 Industrial Ave, Quezon City",
        )
        seed_supplier_account(
            "Fresh Harvest Trading", "SUP-0002", "Maria Santos",
            "orders@freshharvest.ph", "+63 918 555 0202", "45 Farmers Market Rd, Makati",
        )
        seed_supplier_account(
            "Golden Grain Co.", "SUP-0003", "Pedro Reyes",
            "orders@goldengrain.ph", "+63 919 555 0303", "88 Grain Terminal, Pasig",
        )
        legacy_supplier = User.query.filter_by(username="supplier", role="supplier").first()
        if legacy_supplier:
            profile = UserProfile.query.filter_by(user_id=legacy_supplier.id).first()
            company = profile.company_name if profile and profile.company_name else "Metro Meats Supply"
            if not User.query.filter_by(username=company).first() or company == "supplier":
                legacy_supplier.username = company if company != "supplier" else "Metro Meats Supply"
        db.session.commit()

initialize_app()

if __name__ == "__main__":
    app.run(debug=True)
