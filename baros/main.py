"""BarOS application entrypoint.

The product core lives in core.py. platform_layer.py registers platform-owner RBAC,
admin venue switching, and staging security controls on the same FastAPI app.
"""
from .core import app
from . import platform_layer as _platform_layer  # noqa: F401,E402

__all__ = ["app"]
