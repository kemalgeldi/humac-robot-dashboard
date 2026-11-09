import re
import secrets
import sqlite3
from contextlib import closing

import pytest
from werkzeug.security import generate_password_hash

from app import create_app


@pytest.fixture
def app(tmp_path):
    app = create_app({'TESTING': True, 'SECRET_KEY': secrets.token_hex(32),
                      'DATABASE': str(tmp_path / 'test.db'), 'RATELIMIT_ENABLED': False})
    return app


@pytest.fixture
def client(app):
    return app.test_client()


def token(client, path='/login'):
    page = client.get(path).get_data(as_text=True)
    return re.search(r'name="csrf-token" content="([^"]+)"', page)[1]


def add_user(app, username='operator', role='user'):
    password = secrets.token_urlsafe(20)
    with closing(sqlite3.connect(app.config['DATABASE'])) as conn, conn:
        cursor = conn.execute('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)',
                              (username, generate_password_hash(password), role))
        return cursor.lastrowid, password


def login(client, username, password):
    return client.post('/login', data={'username': username, 'password': password, 'csrf_token': token(client)})


def test_no_default_key(monkeypatch):
    monkeypatch.delenv('SECRET_KEY', raising=False)
    with pytest.raises(RuntimeError, match='SECRET_KEY'):
        create_app()


def test_access_csrf_registration_and_logout(app, client):
    assert client.get('/').status_code == 302
    assert client.get('/register').status_code == 404
    assert client.post('/login', data={'username': 'x', 'password': 'x'}).status_code == 400
    _, password = add_user(app)
    assert login(client, 'operator', password).status_code == 302
    assert client.get('/').status_code == 200
    assert client.get('/admin').status_code == 403
    assert client.get('/logout').status_code == 405
    assert client.post('/logout').status_code == 400
    csrf = token(client, '/')
    assert client.post('/logout', data={'csrf_token': csrf}).status_code == 302
    assert client.get('/').status_code == 302


def test_validation_and_wrong_password(app, client):
    assert client.post('/login', data={'csrf_token': token(client)}).status_code == 400
    add_user(app)
    assert login(client, 'operator', 'incorrect-password').status_code == 401
    assert login(client, 'not-an-account', 'incorrect-password').status_code == 401


def test_admin_permissions_and_csrf(app, client):
    admin_id, password = add_user(app, 'admin', 'admin')
    user_id, user_password = add_user(app)
    assert login(client, 'admin', password).status_code == 302
    csrf = token(client, '/admin')
    endpoint = f'/api/admin/toggle_role/{user_id}'
    assert client.post(endpoint).status_code == 400
    headers = {'X-CSRFToken': csrf}
    assert client.post(f'/api/admin/toggle_role/{admin_id}', headers=headers).status_code == 400
    assert client.delete(f'/api/admin/delete/{admin_id}', headers=headers).status_code == 400
    assert client.post(endpoint, headers=headers).json['new_role'] == 'admin'
    assert client.post(endpoint, headers=headers).json['new_role'] == 'user'
    assert client.delete('/api/admin/delete/9999', headers=headers).status_code == 404
    assert client.delete(f'/api/admin/delete/{user_id}', headers=headers).status_code == 200
    other = app.test_client()
    assert login(other, 'operator', user_password).status_code == 401


def test_user_cannot_admin_and_deleted_sessions_revoked(app, client):
    user_id, password = add_user(app)
    admin_id, admin_password = add_user(app, 'admin', 'admin')
    login(client, 'operator', password)
    csrf = token(client, '/')
    assert client.post(f'/api/admin/toggle_role/{admin_id}', headers={'X-CSRFToken': csrf}).status_code == 403
    admin = app.test_client()
    login(admin, 'admin', admin_password)
    admin_csrf = token(admin, '/admin')
    admin.delete(f'/api/admin/delete/{user_id}', headers={'X-CSRFToken': admin_csrf})
    assert client.get('/').status_code == 302


def test_cli_create_reset_and_session_revocation(app, client):
    runner = app.test_cli_runner()
    password = secrets.token_urlsafe(20)
    result = runner.invoke(args=['create-user', 'first-operator'], input=f'{password}\n{password}\n')
    assert result.exit_code == 0, result.output
    with closing(sqlite3.connect(app.config['DATABASE'])) as conn:
        assert conn.execute('SELECT role FROM users').fetchone()[0] == 'user'
    assert runner.invoke(args=['create-user', 'bad name'], input=f'{password}\n{password}\n').exit_code != 0
    assert runner.invoke(args=['create-user', 'short-password'], input='short\nshort\n').exit_code != 0
    login(client, 'first-operator', password)
    replacement = secrets.token_urlsafe(20)
    assert runner.invoke(args=['reset-password', 'first-operator'], input=f'{replacement}\n{replacement}\n').exit_code == 0
    assert client.get('/').status_code == 302
    assert login(client, 'first-operator', password).status_code == 401
    assert login(client, 'first-operator', replacement).status_code == 302


def test_rate_limit(tmp_path):
    app = create_app({'TESTING': True, 'SECRET_KEY': secrets.token_hex(32), 'DATABASE': str(tmp_path / 'limit.db')})
    client = app.test_client()
    csrf = token(client)
    responses = [client.post('/login', data={'username': 'missing', 'password': 'incorrect-password', 'csrf_token': csrf}) for _ in range(6)]
    assert [r.status_code for r in responses] == [401] * 5 + [429]


def test_migrates_legacy_database_without_losing_users(tmp_path):
    path = tmp_path / 'legacy.db'
    password = secrets.token_urlsafe(20)
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.execute('CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL)')
        conn.execute('INSERT INTO users VALUES(1,?,?,?)', ('legacy-admin', generate_password_hash(password), 'admin'))
    app = create_app({'TESTING': True, 'SECRET_KEY': secrets.token_hex(32), 'DATABASE': str(path), 'RATELIMIT_ENABLED': False})
    client = app.test_client()
    assert login(client, 'legacy-admin', password).status_code == 302
    assert client.get('/admin').status_code == 200


def test_username_is_not_embedded_in_javascript(app, client):
    _, password = add_user(app, 'admin', 'admin')
    add_user(app, "');alert(1);//")
    login(client, 'admin', password)
    page = client.get('/admin').get_data(as_text=True)
    assert "onclick=" not in page
    assert "data-delete-user" in page
    assert '&#39;' in page
    assert 'data-logout' in page
    assert 'no-store' == client.get('/').headers['Cache-Control']


def test_rendered_pages_have_only_local_assets_and_no_inline_handlers(app, client):
    _, password = add_user(app, 'admin', 'admin')
    pages = [client.get('/login')]
    login(client, 'admin', password)
    pages += [client.get('/'), client.get('/admin')]
    for response in pages:
        assert response.status_code == 200
        html = response.get_data(as_text=True)
        assert not re.search(r'\son[a-z]+=', html)
        assert not re.search(r'<script\s*>', html)
        for url in re.findall(r'(?:src|href)="(/static/[^"]+)"', html):
            assert client.get(url).status_code == 200, url
        assert "script-src 'self'" in response.headers['Content-Security-Policy']
