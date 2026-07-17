"""Linux 生产环境 WSGI 入口（gunicorn wsgi:app）。"""
import os

from app_paths import default_config_path
from web_app import create_app

app = create_app(os.environ.get("IP_ANNOUNCE_CONFIG", default_config_path()))
