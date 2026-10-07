"""Production entrypoint. Legacy data is migrated additively on first startup."""
from .v2.app import app
__all__ = ['app']
