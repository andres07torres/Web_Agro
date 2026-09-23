import os
from app import create_app, db

# Entry point for the application
config_name = 'config.ProductionConfig' if os.getenv('DATABASE_URL') else 'config.DevelopmentConfig'
app = create_app(config_name)
if __name__ == '__main__':
    # Use environment variable for debug status
    is_debug = os.getenv('FLASK_DEBUG', 'False').lower() == 'true'
    app.run(debug=is_debug)