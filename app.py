"""HUMAC robot dashboard. Robot communication stays on the trusted local network."""
import os
import re
import sqlite3
from contextlib import closing
from datetime import timedelta
from pathlib import Path

import click
from flask import Flask, flash, jsonify, redirect, render_template, request, session, url_for
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_login import LoginManager, UserMixin, current_user, login_required, login_user, logout_user
from flask_wtf.csrf import CSRFError, CSRFProtect
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent


class User(UserMixin):
    def __init__(self, row):
        self.id = row['id']
        self.username = row['username']
        self.role = row['role']
        self.auth_version = row['auth_version']


def create_app(test_config=None):
    app = Flask(__name__)
    app.config.from_mapping(
        SECRET_KEY=os.environ.get('SECRET_KEY'),
        DATABASE=str(BASE_DIR / 'harvester.db'),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Strict',
        SESSION_COOKIE_SECURE=os.environ.get('COOKIE_SECURE') == '1',
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        MAX_CONTENT_LENGTH=16 * 1024,
        RATELIMIT_STORAGE_URI=os.environ.get('RATELIMIT_STORAGE_URI', 'memory://'),
    )
    if test_config:
        app.config.update(test_config)
    key = app.config['SECRET_KEY']
    if not isinstance(key, str) or len(key) < 32:
        raise RuntimeError('Set SECRET_KEY to a random value of at least 32 characters. See README.md.')

    CSRFProtect(app)
    limiter = Limiter(get_remote_address, app=app, default_limits=[])
    app.extensions['login_limiter'] = limiter
    login_manager = LoginManager(app)
    login_manager.login_view = 'login'
    login_manager.session_protection = 'strong'
    dummy_hash = generate_password_hash(os.urandom(32).hex())

    def connect_db():
        conn = sqlite3.connect(app.config['DATABASE'], timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    # Idempotent initialization also works under flask CLI / a WSGI server.
    with closing(connect_db()) as conn, conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute('''CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            auth_version INTEGER NOT NULL DEFAULT 0
        )''')
        columns = {row['name'] for row in conn.execute('PRAGMA table_info(users)')}
        if 'auth_version' not in columns:
            conn.execute('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0')

    @login_manager.user_loader
    def load_user(user_id):
        with closing(connect_db()) as conn:
            row = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
        if row and session.get('auth_version') == row['auth_version']:
            return User(row)
        return None

    @login_manager.unauthorized_handler
    def unauthorized():
        if request.path.startswith('/api/'):
            return jsonify(error='Authentication required'), 401
        return redirect(url_for('login'))

    @app.after_request
    def security_headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' http: data:; connect-src 'self' ws:; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
        )
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
        if request.endpoint != 'static':
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.errorhandler(CSRFError)
    def csrf_error(error):
        if request.path.startswith('/api/'):
            return jsonify(error='Invalid or expired security token. Reload the page.'), 400
        return 'Invalid or expired security token. Reload the page and try again.', 400

    @app.errorhandler(429)
    def rate_limit_error(error):
        return 'Too many login attempts. Please wait before trying again.', 429

    @app.get('/')
    @login_required
    def dashboard():
        return render_template('dashboard.html')

    @app.route('/login', methods=['GET', 'POST'])
    @limiter.limit('5 per minute;30 per hour', methods=['POST'])
    def login():
        if current_user.is_authenticated:
            return redirect(url_for('dashboard'))
        if request.method == 'POST':
            username = request.form.get('username', '').strip()
            password = request.form.get('password', '')
            if not username or len(username) > 64 or not password or len(password) > 256:
                flash('Invalid username or password.', 'error')
                return render_template('login.html', is_login=True), 400
            with closing(connect_db()) as conn:
                row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
            valid = check_password_hash(row['password_hash'] if row else dummy_hash, password)
            if row and valid:
                session.clear()
                login_user(User(row))
                session['auth_version'] = row['auth_version']
                session.permanent = True
                return redirect(url_for('dashboard'))
            flash('Invalid username or password.', 'error')
            return render_template('login.html', is_login=True), 401
        return render_template('login.html', is_login=True)

    @app.post('/logout')
    @login_required
    def logout():
        logout_user()
        session.clear()
        return redirect(url_for('login'))

    @app.get('/admin')
    @login_required
    def admin_panel():
        if current_user.role != 'admin':
            return 'Admin privileges required.', 403
        with closing(connect_db()) as conn:
            users = conn.execute('SELECT id, username, role FROM users ORDER BY id').fetchall()
        return render_template('admin.html', users=users)

    @app.post('/api/admin/toggle_role/<int:user_id>')
    @login_required
    def toggle_role(user_id):
        if current_user.role != 'admin':
            return jsonify(error='Admin privileges required'), 403
        if user_id == current_user.id:
            return jsonify(error='Cannot modify your own role'), 400
        with closing(connect_db()) as conn, conn:
            row = conn.execute('SELECT role FROM users WHERE id = ?', (user_id,)).fetchone()
            if not row:
                return jsonify(error='User not found'), 404
            role = 'admin' if row['role'] == 'user' else 'user'
            conn.execute('UPDATE users SET role = ?, auth_version = auth_version + 1 WHERE id = ?', (role, user_id))
        return jsonify(success=True, new_role=role)

    @app.delete('/api/admin/delete/<int:user_id>')
    @login_required
    def delete_user(user_id):
        if current_user.role != 'admin':
            return jsonify(error='Admin privileges required'), 403
        if user_id == current_user.id:
            return jsonify(error='Cannot delete yourself'), 400
        with closing(connect_db()) as conn, conn:
            deleted = conn.execute('DELETE FROM users WHERE id = ?', (user_id,)).rowcount
        if not deleted:
            return jsonify(error='User not found'), 404
        return jsonify(success=True)

    def validate_password(password):
        if not 12 <= len(password) <= 256:
            raise click.ClickException('Use a password of 12 to 256 characters.')

    @app.cli.command('create-user')
    @click.argument('username')
    @click.option('--admin', is_flag=True, help='Grant administrator access explicitly.')
    @click.password_option(confirmation_prompt=True)
    def create_user(username, admin, password):
        """Create an operator locally; web registration is intentionally disabled."""
        if not re.fullmatch(r'[A-Za-z0-9_.-]{3,64}', username):
            raise click.ClickException('Username: 3–64 letters, numbers, dots, underscores or hyphens.')
        validate_password(password)
        try:
            with closing(connect_db()) as conn, conn:
                conn.execute('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
                             (username, generate_password_hash(password), 'admin' if admin else 'user'))
        except sqlite3.IntegrityError:
            raise click.ClickException('Username already exists.') from None
        click.echo('Account created.')

    @app.cli.command('reset-password')
    @click.argument('username')
    @click.password_option(confirmation_prompt=True)
    def reset_password(username, password):
        """Replace an existing password and invalidate its previous sessions."""
        validate_password(password)
        with closing(connect_db()) as conn, conn:
            changed = conn.execute('UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE username = ?',
                                   (generate_password_hash(password), username)).rowcount
        if not changed:
            raise click.ClickException('User not found.')
        click.echo('Password changed; previous sessions revoked.')

    return app


if __name__ == '__main__':
    create_app().run(host='127.0.0.1', port=5000, debug=False)
