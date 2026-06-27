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
db = SQLAlchemy(app)

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
PASSWORD_MIN_LENGTH = 10
PASSWORD_HISTORY_LIMIT = 3
PASSWORD_REQUIREMENT_MESSAGE = "Password must contain at least 10 characters, including uppercase, lowercase, number, and special character."
LOGIN_ERROR_MESSAGE = "Please enter the correct username and password."

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
    total = db.Column(db.Float)
    status = db.Column(db.String(50))
    type = db.Column(db.String(50))
    date = db.Column(db.String(50))
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
    status = db.Column(db.String(50), default="Pending")
    date = db.Column(db.String(80))
    review_note = db.Column(db.Text)

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

def create_po_from_purchase_request(pr_record):
    """Create and send a purchase order when a purchase request is approved."""
    existing = PurchaseOrder.query.filter_by(source_pr_id=pr_record.id).first()
    if existing:
        return existing

    item = Inventory.query.filter(db.func.lower(Inventory.name) == pr_record.item_name.lower()).first()
    supplier = item.supplier_name if item and item.supplier_name else "Default Supplier"
    unit = pr_record.unit or (item.unit if item else "pcs")
    price = get_supplier_price(supplier, pr_record.item_name)
    po_id = f"PO-{datetime.now().strftime('%Y%m%d%H%M%S')}"

    po = PurchaseOrder(
        id=po_id,
        item_name=pr_record.item_name,
        qty=pr_record.qty,
        unit=unit,
        supplier=supplier,
        total=pr_record.qty * price,
        status="Waiting for Supplier",
        type="From Purchase Request",
        date=datetime.now().strftime("%B %d, %Y"),
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
    return po

def sync_low_stock_alerts():
    """
    Scans the entire inventory table. For any item at or below its threshold,
    it automatically injects an 'Awaiting approval' order if one doesn't exist.
    """
    low_items = Inventory.query.filter(Inventory.stock <= Inventory.threshold).all()
    
    for item in low_items:
        # Prevent duplicate orders: check if an 'Awaiting approval' order already exists for this item
        existing_po = PurchaseOrder.query.filter_by(
            item_name=item.name,
            status="Awaiting approval"
        ).first()
        
        if not existing_po:
            # Generate a clean, unique PO ID using the current timestamp
            po_id = f"PO-{datetime.now().strftime('%Y%m%d%H%M%S')}-{item.id}"
            fallback_supplier = item.supplier_name if item.supplier_name else "Default Supplier"
            
            # Restock quantity defaults to double the safety threshold (or at least 50 units)
            reorder_qty = max(item.threshold * 2, 50.0)
            price = get_supplier_price(fallback_supplier, item.name)
            
            # Insert the automated draft order
            auto_po = PurchaseOrder(
                id=po_id,
                item_name=item.name,
                qty=reorder_qty,
                unit=item.unit if item.unit else "pcs",
                supplier=fallback_supplier,
                status="Awaiting approval",
                type="Auto-Generated",
                total=reorder_qty * price,
                date=datetime.now().strftime('%B %d, %Y')
            )
            
            # Log it in the activity history
            auto_log = ActivityLog(
                event="Auto-Generated Draft Order",
                item=item.name,
                reference=po_id,
                status="Awaiting approval",
                time=datetime.now().strftime("%H:%M")
            )
            
            db.session.add(auto_po)
            db.session.add(auto_log)

    # Commit any newly generated draft orders to the database
    db.session.commit()

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
    if session.get("role") != "staff":
        return redirect("/")
    if session.get("password_expired"):
        return redirect("/change-password")
    user = User.query.filter_by(username=session.get("username"), role="staff").first()
    days_remaining = password_days_remaining(user) if user else PASSWORD_EXPIRY_DAYS
    return render_template("staff.html", username=session.get("username", "staff"), days_remaining=days_remaining)

@app.route("/manager")
def manager():
    if not session.get("manager_authenticated"):
        return redirect("/")
    if session.get("password_expired"):
        return redirect("/change-password")
    mgr = ManagerCredential.query.filter_by(username=session.get("manager_username")).first()
    days_remaining = manager_password_days_remaining(mgr) if mgr else PASSWORD_EXPIRY_DAYS
    return render_template("manager.html", is_manager=True, username=session.get("manager_username", "mgr.primary"), days_remaining=days_remaining)

@app.route("/profile")
def profile_page():
    role = session.get("role")
    if role not in {"manager", "staff", "supplier"}:
        return redirect("/")
    if session.get("password_expired"):
        return redirect("/change-password")
    username = session.get("manager_username") if role == "manager" else session.get("username")
    return render_template("profile.html", username=username, role=role)

@app.route("/supplier")
def supplier():
    if session.get("role") != "supplier":
        return redirect("/")
    if session.get("password_expired"):
        return redirect("/change-password")
    user = User.query.filter_by(username=session.get("username"), role="supplier").first()
    days_remaining = password_days_remaining(user) if user else PASSWORD_EXPIRY_DAYS
    return render_template("supplier.html", username=session.get("username", "supplier"), days_remaining=days_remaining)

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
            session.clear()
            session["manager_authenticated"] = True
            session["manager_username"] = username
            session["role"] = "manager"
            if manager_password_is_expired(manager_account):
                session["password_expired"] = True
                return redirect("/change-password")
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

    session.clear()
    session["role"] = account_role
    session["username"] = user.username
    if password_is_expired(user):
        session["password_expired"] = True
        return redirect("/change-password")
    return redirect("/staff" if account_role == "staff" else "/supplier")

@app.route("/logout")
def logout():
    session.clear()
    return redirect("/")

@app.route("/change-password", methods=["GET", "POST"])
def change_password():
    role = session.get("role")
    if role not in {"manager", "staff", "supplier"}:
        return redirect("/")

    ensure_user_schema()
    username = session.get("manager_username") if role == "manager" else session.get("username")
    expired = bool(session.get("password_expired"))
    error = None

    if request.method == "POST":
        current_password = request.form.get("current_password", "")
        new_password = request.form.get("new_password", "")
        confirm_password = request.form.get("confirm_password", "")

        if new_password != confirm_password:
            error = "New password and confirmation do not match."
        elif not password_meets_requirements(new_password):
            error = PASSWORD_REQUIREMENT_MESSAGE
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
            session.pop("password_expired", None)
            destination = "/manager" if role == "manager" else f"/{role}"
            return f'<script>alert("Password updated successfully."); window.location.href="{destination}";</script>'

    return render_template("change_password.html", username=username, role=role, expired=expired, error=error, requirement_message=PASSWORD_REQUIREMENT_MESSAGE)

def manager_api_allowed():
    return bool(session.get("manager_authenticated"))

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

def password_was_used_recently(account_type, account_key, new_password):
    histories = PasswordHistory.query.filter_by(account_type=account_type, account_key=account_key).order_by(PasswordHistory.id.desc()).limit(PASSWORD_HISTORY_LIMIT).all()
    for entry in histories:
        if check_password_hash(entry.password_hash, new_password):
            return True
    if account_type == "manager":
        account = ManagerCredential.query.filter_by(username=account_key).first()
    else:
        account = User.query.filter_by(username=account_key, role=account_type).first()
    if account and check_password_hash(account.password_hash, new_password):
        return True
    return False

def supplier_api_allowed():
    return session.get("role") == "supplier" and not session.get("password_expired")

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
    return jsonify([{
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "disabled": user.is_disabled
    } for user in users])

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
    if role not in {"staff", "supplier"} or not username:
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
    else:
        if not password_meets_requirements(password):
            return jsonify({"error": PASSWORD_REQUIREMENT_MESSAGE}), 400
        user = User(username=username, role=role, password_hash=generate_password_hash(password), password_changed_at=None)
        db.session.add(user)
        db.session.flush()
        profile = UserProfile(user_id=user.id, supplier_id=f"SUP-{user.id:04d}" if role == "supplier" else "")
        if role == "supplier" and data.get("companyName"):
            profile.company_name = str(data.get("companyName")).strip()
        db.session.add(profile)
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

    return jsonify([
        {
            "id": i.id,
            "name": i.name,
            "stock": i.stock,
            "threshold": i.threshold,
            "unit": i.unit,
            "supplier": i.supplier_name
        }
        for i in items
    ])

@app.route("/api/inventory/add", methods=["POST"])
def add_inventory():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    data = request.json

    item = Inventory(
        name=data["name"],
        stock=data.get("stock",0),
        threshold=data.get("threshold",0),
        unit=data.get("unit"),
        supplier_name=data.get("supplier")
    )

    db.session.add(item)
    db.session.commit()
    
    # Check if newly added item is already under safety stock limits
    check_and_auto_reorder(item.id)
    return jsonify({"status":"success"})

# --- AUTOMATIC REORDER TRIGGER FUNCTION ---
def check_and_auto_reorder(item_id):
    """
    Checks if an item's stock has dropped to or below its threshold.
    If so, automatically creates an 'Awaiting approval' Purchase Order.
    """
    item = Inventory.query.get(item_id)
    if not item:
        return

    # Check if stock is low
    if item.stock <= item.threshold:
        # Prevent duplicates: Check if there's already an active "Awaiting approval" order for this item
        existing_po = PurchaseOrder.query.filter_by(
            item_name=item.name, 
            status="Awaiting approval"
        ).first()
        
        if not existing_po:
            # Calculate a standard reorder quantity (e.g., restocking up to double the threshold, or a flat default like 50)
            reorder_qty = max(item.threshold * 2, 50.0) 
            
            # Generate a new Purchase Order entry
            # Finding a fallback supplier if none is attached to the item catalog description
            supplier_name = item.supplier_name if item.supplier_name else "Default Supplier"
            po_id = f"PO-{datetime.now().strftime('%Y%m%d%H%M%S')}-{item.id}"
            
            price = get_supplier_price(supplier_name, item.name)

            auto_po = PurchaseOrder(
                id=po_id,
                item_name=item.name,
                qty=reorder_qty,
                unit=item.unit if item.unit else "pcs",
                supplier=supplier_name,
                status="Awaiting approval",
                type="Auto-Generated",
                total=reorder_qty * price,
                date=datetime.now().strftime('%B %d, %Y')
            )
            
            # Log the event into the activity trail
            auto_log = ActivityLog(
                event="Auto-Generated Purchase Order",
                item=item.name,
                reference=po_id,
                status="Awaiting approval",
                time=datetime.now().strftime("%H:%M")
            )
            
            db.session.add(auto_po)
            db.session.add(auto_log)
            db.session.commit()

# --- UPDATE INVENTORY REST API ROUTE ---
# Ensure that whenever an endpoint modifies inventory stock downwards, the check triggers.
@app.route("/api/inventory/update", methods=["POST"])
def update_inventory():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    data = request.json
    item_id = data.get("id")
    new_stock = data.get("stock")
    
    item = Inventory.query.get(item_id)
    if not item:
        return jsonify({"status": "error", "message": "Item not found"}), 404
        
    item.stock = new_stock
    db.session.commit()
    
    # Trigger the automated check right after updating the database stock level
    check_and_auto_reorder(item.id)
    sync_low_stock_alerts()
    return jsonify({"status": "success"})

@app.route("/api/inventory/delete", methods=["POST"])
def delete_inventory():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    data=request.json
    item=Inventory.query.get(data["id"])
    
    if item:
        db.session.delete(item)
        db.session.commit()

    return jsonify({"status":"success"})

@app.route("/api/inventory/update-threshold", methods=["POST"])
def update_threshold():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    data = request.json
    item = Inventory.query.get(data["id"])

    if item:
        item.threshold = data["threshold"]
        db.session.commit()
        
        # Trigger reorder if the threshold update pushed the requirement beyond current stock
        check_and_auto_reorder(item.id)

        return jsonify({"status":"success"})

    return jsonify({"status":"error"})

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
    data=request.json

    supplier=Supplier(
        name=data["name"],
        email=data["email"],
        phone=data["phone"],
        catalog=json.dumps(data.get("catalog",[]))
    )

    db.session.add(supplier)
    db.session.commit()
    return jsonify({"status":"success"})

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
    orders=PurchaseOrder.query.all()

    return jsonify([
        {
            "id":o.id,
            "itemName":o.item_name,
            "qty":o.qty,
            "unit":o.unit,
            "supplier":o.supplier,
            "total":o.total,
            "status":o.status,
            "type":o.type,
            "date":o.date
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
@app.route("/api/activity")
def get_activity():
    logs=ActivityLog.query.order_by(
        ActivityLog.id.desc()
    ).all()

    return jsonify([
        {
            "event":l.event,
            "item":l.item,
            "reference":l.reference,
            "status":l.status,
            "time":l.time
        }
        for l in logs
    ])

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
    return session.get("role") == "staff" and not session.get("password_expired")

def delivery_id_for_po(po_id):
    clean_id = "".join(character for character in str(po_id) if character.isalnum())
    return f"DEL-{clean_id[-8:].upper()}"

@app.route("/api/staff/profile")
def staff_profile():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    return jsonify({"username": session.get("username", "staff"), "role": "Inventory Staff"})

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
    if not item or adjustment_type not in {"Damaged", "Expired", "Correction"} or not reason or quantity == 0:
        return jsonify({"error": "Complete all adjustment fields with a valid quantity."}), 400

    previous_stock = float(item.stock or 0)
    new_stock_raw = data.get("newStock")
    if new_stock_raw is not None and new_stock_raw != "":
        try:
            new_stock = max(0, float(new_stock_raw))
        except (TypeError, ValueError):
            return jsonify({"error": "Enter a valid current stock level."}), 400
        recorded_quantity = new_stock - previous_stock
    elif adjustment_type in {"Damaged", "Expired"}:
        new_stock = max(0, previous_stock - abs(quantity))
        recorded_quantity = -abs(quantity)
    else:
        new_stock = max(0, previous_stock + quantity)
        recorded_quantity = quantity

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
        staff_username=session.get("username", "staff"),
        date=timestamp
    )
    db.session.add(record)
    db.session.add(ActivityLog(event="Stock Adjustment Recorded", item=item.name, reference=reason, status=adjustment_type, time=datetime.now().strftime("%H:%M")))
    db.session.commit()
    check_and_auto_reorder(item.id)
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
    order = next((po for po in PurchaseOrder.query.all() if delivery_id_for_po(po.id).lower() == delivery_id.lower() or po.id.lower() == delivery_id.lower()), None)
    if not order:
        return jsonify({"error": "Delivery ID was not found."}), 404
    existing = ReceivingRecord.query.filter_by(po_id=order.id).first()
    return jsonify({
        "deliveryId": existing.delivery_id if existing else delivery_id_for_po(order.id),
        "poNumber": order.id,
        "supplier": order.supplier or "Unassigned Supplier",
        "itemName": order.item_name,
        "expectedQuantity": order.qty,
        "unit": order.unit,
        "status": existing.status if existing else ("Pending" if order.status == "Transmitted" else order.status),
        "alreadyReceived": bool(existing)
    })

@app.route("/api/staff/deliveries/confirm", methods=["POST"])
def confirm_staff_delivery():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    data = request.get_json(silent=True) or {}
    order = PurchaseOrder.query.get(data.get("poNumber"))
    if not order:
        return jsonify({"error": "Purchase order was not found."}), 404
    if ReceivingRecord.query.filter_by(po_id=order.id).first():
        return jsonify({"error": "This delivery has already been recorded."}), 409
    try:
        received_quantity = float(data.get("receivedQuantity", 0))
    except (TypeError, ValueError):
        received_quantity = 0
    condition = str(data.get("condition", ""))
    decision = str(data.get("decision", ""))
    status_map = {"complete": "Delivered", "partial": "Partial", "reject": "Rejected"}
    if decision not in status_map or condition not in {"Good Condition", "Damaged", "Partial Delivery"}:
        return jsonify({"error": "Select the item condition and receiving decision."}), 400
    if decision != "reject" and received_quantity <= 0:
        return jsonify({"error": "Enter the quantity received."}), 400

    status = status_map[decision]
    if decision == "reject":
        received_quantity = 0
    else:
        item = Inventory.query.filter(db.func.lower(Inventory.name) == order.item_name.lower()).first()
        if item:
            item.stock = float(item.stock or 0) + received_quantity

    timestamp = datetime.now().strftime("%B %d, %Y · %I:%M %p")
    delivery_id = delivery_id_for_po(order.id)
    receipt = ReceivingRecord(
        delivery_id=delivery_id,
        po_id=order.id,
        supplier=order.supplier or "Unassigned Supplier",
        item_name=order.item_name,
        expected_quantity=float(order.qty or 0),
        received_quantity=received_quantity,
        condition=condition,
        status=status,
        received_by=session.get("username", "staff"),
        date_received=timestamp
    )
    order.status = status
    db.session.add(receipt)
    db.session.add(DeliveryRecord(qr_value=delivery_id, po_id=order.id, status=status, time=datetime.now().strftime("%H:%M")))
    db.session.add(ActivityLog(event="Delivery Received" if status != "Rejected" else "Delivery Rejected", item=order.item_name, reference=delivery_id, status=status, time=datetime.now().strftime("%H:%M")))
    db.session.commit()
    return jsonify({"status": "success", "deliveryStatus": status})

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
    role = session.get("role")
    if role not in {"manager", "staff", "supplier"}:
        return jsonify({"error": "Unauthorized"}), 401
    username = session.get("manager_username") if role == "manager" else session.get("username")
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
    role = session.get("role")
    if role == "staff":
        if not staff_api_allowed():
            return jsonify({"error": "Unauthorized"}), 403
        requests_list = PurchaseRequest.query.filter_by(requested_by=session.get("username")).order_by(PurchaseRequest.id.desc()).all()
    elif manager_api_allowed():
        requests_list = PurchaseRequest.query.order_by(PurchaseRequest.id.desc()).all()
    else:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify([{
        "id": r.id,
        "itemName": r.item_name,
        "qty": r.qty,
        "unit": r.unit,
        "reason": r.reason,
        "requestedBy": r.requested_by,
        "status": r.status,
        "date": r.date,
        "reviewNote": r.review_note,
    } for r in requests_list])

@app.route("/api/purchase-requests", methods=["POST"])
def create_purchase_request():
    if not staff_api_allowed():
        return jsonify({"error": "Inventory Staff access required"}), 403
    data = request.get_json(silent=True) or {}
    item_name = str(data.get("itemName", "")).strip()
    try:
        qty = float(data.get("qty", 0))
    except (TypeError, ValueError):
        qty = 0
    if not item_name or qty <= 0:
        return jsonify({"error": "Item name and quantity are required."}), 400
    req_id = f"PR-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    record = PurchaseRequest(
        id=req_id,
        item_name=item_name,
        qty=qty,
        unit=data.get("unit", "pcs"),
        reason=str(data.get("reason", "")).strip(),
        requested_by=session.get("username", "staff"),
        status="Pending",
        date=datetime.now().strftime("%B %d, %Y · %I:%M %p"),
    )
    db.session.add(record)
    db.session.add(ActivityLog(event="Purchase Request submitted", item=item_name, reference=req_id, status="Pending", time=datetime.now().strftime("%H:%M")))
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
    db.session.add(ActivityLog(event=f"Purchase Request {record.status}", item=record.item_name, reference=record.id, status=record.status, time=datetime.now().strftime("%H:%M")))
    db.session.commit()
    return jsonify({"status": "success", "poId": po_id})

@app.route("/api/support", methods=["GET", "POST"])
def api_support():
    role = session.get("role")
    if role not in {"staff", "supplier"} and not manager_api_allowed():
        return jsonify({"error": "Unauthorized"}), 401
    if request.method == "GET":
        if manager_api_allowed():
            tickets = SupportRequest.query.order_by(SupportRequest.id.desc()).all()
        else:
            username = session.get("username")
            tickets = SupportRequest.query.filter_by(username=username).order_by(SupportRequest.id.desc()).all()
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
        username=session.get("username"),
        role=role,
        category=category,
        subject=subject,
        message=message,
        status="Open",
        date=datetime.now().strftime("%B %d, %Y · %I:%M %p"),
    )
    db.session.add(ticket)
    db.session.add(ActivityLog(event="Support Request submitted", item=category, reference=ticket_id, status="Open", time=datetime.now().strftime("%H:%M")))
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
    db.session.commit()
    return jsonify({"status": "success"})

@app.route("/api/supplier/purchase-orders")
def supplier_purchase_orders():
    if not supplier_api_allowed():
        return jsonify({"error": "Supplier access required"}), 403
    company = get_supplier_company_for_user(session.get("username"))
    orders = PurchaseOrder.query.filter(PurchaseOrder.supplier == company).order_by(PurchaseOrder.id.desc()).all() if company else []
    return jsonify([{
        "id": o.id,
        "itemName": o.item_name,
        "qty": o.qty,
        "unit": o.unit,
        "supplier": o.supplier,
        "total": o.total,
        "status": o.status,
        "type": o.type,
        "date": o.date,
        "deliveryId": delivery_id_for_po(o.id),
    } for o in orders])

@app.route("/api/supplier/purchase-orders/respond", methods=["POST"])
def supplier_respond_po():
    if not supplier_api_allowed():
        return jsonify({"error": "Supplier access required"}), 403
    data = request.get_json(silent=True) or {}
    po = PurchaseOrder.query.get(data.get("id"))
    action = str(data.get("action", "")).lower()
    company = get_supplier_company_for_user(session.get("username"))
    if not po or po.supplier != company or action not in {"accept", "reject"}:
        return jsonify({"error": "Purchase order not found or not assigned to your company."}), 404
    po.status = "Accepted" if action == "accept" else "Rejected by Supplier"
    event = "Purchase Order accepted" if action == "accept" else "Purchase Order rejected"
    db.session.add(ActivityLog(event=event, item=po.item_name, reference=po.id, status=po.status, time=datetime.now().strftime("%H:%M")))
    db.session.commit()
    return jsonify({"status": "success", "deliveryId": delivery_id_for_po(po.id)})

@app.route("/api/supplier/deliveries")
def supplier_deliveries():
    if not supplier_api_allowed():
        return jsonify({"error": "Supplier access required"}), 403
    company = get_supplier_company_for_user(session.get("username"))
    orders = PurchaseOrder.query.filter(PurchaseOrder.supplier == company).order_by(PurchaseOrder.id.desc()).all() if company else []
    receipts = {r.po_id: r for r in ReceivingRecord.query.all()}
    return jsonify([{
        "deliveryId": receipts[o.id].delivery_id if o.id in receipts else delivery_id_for_po(o.id),
        "poNumber": o.id,
        "itemName": o.item_name,
        "qty": o.qty,
        "unit": o.unit,
        "status": receipts[o.id].status if o.id in receipts else o.status,
        "date": o.date,
    } for o in orders if o.status in {"Accepted", "In Transit", "Delivered", "Partial", "Waiting for Supplier"}])

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
    company = get_supplier_company_for_user(session.get("username"))
    orders = PurchaseOrder.query.filter(PurchaseOrder.supplier == company).all() if company else []
    return jsonify({
        "newOrders": len([o for o in orders if o.status in {"Waiting for Supplier", "Transmitted"}]),
        "acceptedOrders": len([o for o in orders if o.status == "Accepted"]),
        "pendingDeliveries": len([o for o in orders if o.status in {"Accepted", "In Transit"}]),
        "completedDeliveries": len([o for o in orders if o.status in {"Delivered", "Partial"}]),
        "rejectedOrders": len([o for o in orders if "Rejected" in (o.status or "")]),
        "profile": profile_payload("supplier", session.get("username")),
    })

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
        if not User.query.filter_by(username="supplier").first():
            supplier_user = User(
                username="supplier",
                password_hash=generate_password_hash("Supplier@2026"),
                role="supplier",
                password_changed_at=None
            )
            db.session.add(supplier_user)
            db.session.flush()
            db.session.add(UserProfile(
                user_id=supplier_user.id,
                supplier_id="SUP-0001",
                company_name="Metro Meats Supply",
                contact_person="Juan Dela Cruz",
                email="orders@metromeats.ph",
                contact_number="+63 917 555 0101",
                business_address="123 Industrial Ave, Quezon City",
            ))
        db.session.commit()

initialize_app()

if __name__ == "__main__":
    app.run(debug=True)
