import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MANUALS_DIR = DATA_DIR / "manuals"  # legacy single-user layout (migrated into users/<admin>/)
USER_DB = DATA_DIR / "lego.sqlite"  # legacy single-user layout
CATALOG_DB = DATA_DIR / "catalog.sqlite"
USERS_DIR = DATA_DIR / "users"
ADMIN_DB = DATA_DIR / "admin.db"
STATIC_DIR = Path(os.environ.get("STATIC_DIR", Path(__file__).resolve().parent.parent / "static"))

# Brickyard (Node server + React builder) integration
BUILDER_DIST = Path(os.environ.get("BUILDER_DIST", Path(__file__).resolve().parent.parent / "builder"))
BUILDER_URL = os.environ.get("BUILDER_URL", "http://127.0.0.1:8787")  # node server, same container
BUILDER_PREFIX = "/by-backend"  # proxy prefix: /by-backend/<p> -> BUILDER_URL/<p>
LDRAW_DIR = Path(os.environ.get("LDRAW_DIR", DATA_DIR / "ldraw" / "ldraw"))

LDRAW_DIR.mkdir(parents=True, exist_ok=True)

REBRICKABLE_API_KEY = os.environ.get("REBRICKABLE_API_KEY", "").strip()
BRICKOGNIZE_URL = os.environ.get("BRICKOGNIZE_URL", "https://api.brickognize.com")
REBRICKABLE_DOWNLOADS = "https://cdn.rebrickable.com/media/downloads"
AUTO_IMPORT_CATALOG = os.environ.get("AUTO_IMPORT_CATALOG", "1") == "1"
DEVICE_NAME = os.environ.get("DEVICE_NAME", "")

ADMIN_USER = (os.environ.get("ADMIN_USER", "admin").strip().lower()) or "admin"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SESSION_COOKIE = "bs_session"

DATA_DIR.mkdir(parents=True, exist_ok=True)
MANUALS_DIR.mkdir(parents=True, exist_ok=True)
