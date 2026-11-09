# HUMAC Robot Dashboard — HARVESTER_OS

A Flask operator dashboard for a palm-harvesting robot. It combines a live camera view, ROS telemetry, mission requests and manual driving in one local web interface.

[Краткая инструкция на русском](README.ru.md)

## Features

- Password-based login and administrator/operator roles.
- Administrator directory for changing roles and deleting accounts.
- Camera stream, robot state, harvested-tree counter, GNSS position and filtered ROS logs.
- START, PAUSE, RESUME and RESET mission requests.
- Hold-to-drive WASD and pointer/touch controls with an explicit manual override.
- Shared movement stop handling, focus-loss cleanup and an explicit software-stop release after each connection.
- CSRF protection, login rate limits, session invalidation on password/role changes, local frontend assets and a Content Security Policy.

## Scope

This repository contains the web dashboard, not the Jetson/robot ROS nodes, robot state machine, motor controller or physical emergency-stop system. The UI can run without a robot; live telemetry and controls require the external services below.

Flask authenticates access to the dashboard. The browser connects **directly** to rosbridge and the camera server. Flask login does not authenticate or protect those robot services. Use a trusted, isolated robot network; do not expose ports 9090 or 8080 to the public internet.

The on-screen E-STOP sends zero velocity and RESET and latches controls locally. It is a **software stop request**, not a hardware safety function or a confirmation that the robot has stopped. The robot must implement its own velocity-command timeout/watchdog and independent physical emergency stop. A disconnected or closed browser cannot guarantee delivery of a final stop message. Multi-operator arbitration must also be enforced on the robot.

## Quick start — macOS / Linux

Use Python 3.10 or newer; the automated tests were run with Python 3.13. Node.js is only needed for JavaScript tests and optional CSS rebuilding.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt

# Generate a local session key. Never put its value into source control.
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_hex(32))')"

# For a new installation, create your own administrator account.
# The password is requested privately twice; use 12–256 characters.
python -m flask --app app:create_app create-user admin --admin

python app.py
```

Open <http://127.0.0.1:5000> and sign in with the account you created. The server binds to the local computer and runs with debugging disabled.

If your system `python3` is older than 3.10 and you have `uv`, create the environment with `uv venv --python 3.13 --seed .venv` instead of `python3 -m venv .venv`, then follow the remaining commands.

Keep the same `SECRET_KEY` in a private environment configuration when you need sessions to survive restarts. Generating a different key signs everyone out. In a new terminal, set the key again before running the app or account commands. `.env.example` documents the variables; `python app.py` does **not** automatically load `.env` files.

### Windows PowerShell

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:SECRET_KEY = python -c "import secrets; print(secrets.token_hex(32))"
python -m flask --app app:create_app create-user admin --admin
python app.py
```

## Existing local installation

The local `harvester.db` is preserved and ignored by Git. The app locates it relative to `app.py`, regardless of the current working directory, and adds the session-version column without deleting existing users.

If an administrator already exists, skip account creation. **Replace any password previously stored in the old setup notes** with this command after exporting `SECRET_KEY`:

```bash
python -m flask --app app:create_app reset-password Admin
```

Use the exact existing username; usernames are case-sensitive. This command asks for a new password and revokes that account's previous sessions. No default credentials or production account database are distributed in Git.

## Account management

Web registration is disabled. Accounts and administrator access are granted explicitly from the machine running Flask:

```bash
python -m flask --app app:create_app create-user operator
python -m flask --app app:create_app create-user another-admin --admin
python -m flask --app app:create_app reset-password operator
```

A regular operator can use robot controls; an administrator additionally manages accounts. There is no separate read-only role. An administrator cannot delete themselves or change their own role through the web panel. Changing another user's role revokes that user's current sessions.

## Robot prerequisites

The operator's browser and robot must be reachable on the same trusted network. On the robot, start its normal camera, navigation, state-machine and motor-control nodes, plus:

```bash
roslaunch rosbridge_server rosbridge_websocket.launch
rosrun web_video_server web_video_server
```

These ROS packages are separate robot dependencies and are not installed by `requirements.txt`. ROS 1 Noetic is the original target; use a maintained robot environment and verify the topic/message contract on your installation.

| Service | Endpoint |
| --- | --- |
| rosbridge | `ws://ROBOT_HOST:9090` |
| Camera | `http://ROBOT_HOST:8080/stream` |
| Camera topic | `/camera/color/image_raw` |

Enter the robot's IPv4 address or hostname in the dashboard and select **CONNECT**. Do not include a URL scheme or port. IPv6 addresses and custom ports are not currently supported.

### ROS interface

| Topic | Message type | Direction / purpose |
| --- | --- | --- |
| `/cmd_vel` | `geometry_msgs/Twist` | Publish manual linear/angular velocity |
| `/start_mission` | `std_msgs/String` | Publish `START`, `PAUSE`, `RESUME`, `RESET`, `MANUAL_ON`, `MANUAL_OFF` |
| `/current_state` | `std_msgs/String` | Subscribe to robot state |
| `/trees_done` | `std_msgs/Int32` | Subscribe to harvest count |
| `/gps/fix` | `sensor_msgs/NavSatFix` | Subscribe to GNSS position |
| `/rosout_agg` | `rosgraph_msgs/Log` | Subscribe to aggregated logs |

The original state mapping is 4 = manual, 6 = permission and 7 = paused. Verify that your robot's state machine implements these commands and state values. A successful WebSocket publish is not a robot acknowledgement.

## Controls and behavior

1. **CONNECT** creates a fresh ROS connection, clears old input and requests zero velocity and RESET. Software stop stays engaged until explicitly released.
2. **RELEASE STOP** asks for confirmation and clears the local stop latch. It does not start a mission.
3. **START MISSION** requests autonomous operation. START and pause/resume are blocked while software stop or manual override is active. Pause/resume is also blocked in the permission state.
4. **MANUAL OVERRIDE** enables WASD and directional buttons. Hold to drive; release to stop. The requested speed is 0.5 m/s linear and 0.5 rad/s angular; confirm these values are appropriate on your robot before operating.
5. **STOP** clears held input and its repeat timer and sends zero velocity. Holding the same key down does not restart movement until it is released and pressed again.
6. **E-STOP** clears manual input, sends zero velocity, MANUAL_OFF when relevant and RESET, and blocks subsequent movement and mission-start requests locally.
7. Losing focus, hiding the tab or logging out clears manual control and requests PAUSE for autonomous activity when connected. It never automatically resumes on return.
8. A transport failure clears local control state. Reconnection requires explicitly releasing the stop and re-enabling manual mode. No stale velocity command is intentionally queued for reconnection.

WASD is ignored while typing in a form field or focusing a button. Click an empty area of the dashboard before keyboard driving. Pointer/touch direction buttons use pointer capture and share the same stop routine.

MJPEG images do not expose reliable frame timestamps to JavaScript. The FPS card shows no measured value rather than a misleading estimate. The stream indicator only reflects an image load; it is not a freshness watchdog.

## Configuration and deployment limits

| Environment variable | Purpose |
| --- | --- |
| `SECRET_KEY` | Required, random value of at least 32 characters; never committed |
| `COOKIE_SECURE` | Set to `1` when serving over HTTPS; default `0` permits local HTTP |
| `RATELIMIT_STORAGE_URI` | Default `memory://` for one local process; use a shared store for multiple workers |

Login requests are limited to 5 per minute and 30 per hour per source IP. The memory limiter resets on restart and is not shared across processes. A shared backend such as Redis requires installing its client extra and configuring the URI. Do not trust forwarded client-IP headers without a correctly configured trusted proxy.

The default app is for local operation. Public deployment requires a production WSGI server, HTTPS, protected robot services and a TLS-capable robot gateway. The current dashboard deliberately rejects ROS connections from an HTTPS page because its robot endpoints use plain `ws://` and `http://`; a gateway integration requires corresponding URL and CSP changes. GitHub Pages cannot run the Flask backend.

## Tests

No real robot is contacted by these tests. Backend tests use temporary databases. JavaScript tests use a simulated transport and DOM to check movement interlocks and disconnect behavior.

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
node --test tests/controls.test.cjs
```

Node.js 22+ is recommended. The GitHub Actions workflow runs the same backend and control checks on each push and pull request. Hardware stopping distance, controller watchdog behavior, camera streaming and actual ROS compatibility still require supervised robot testing.

## Frontend assets

The compiled CSS and ROSLIB bundle are included locally, so normal use needs no CDN connection and no Node.js build step. ROSLIB 1.4.1 includes its event emitter dependency; a second external EventEmitter script is unnecessary.

To rebuild CSS after changing classes, run this from the repository root with Node.js/npm installed:

```bash
npx --yes tailwindcss@3.4.19 -c tailwind.config.cjs -i static/input.css -o static/styles.css --minify
```

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled asset sources and licenses.

## Project structure

```text
app.py                       Flask app factory, account commands and admin API
requirements.txt             Pinned direct runtime dependencies
requirements-dev.txt         Test dependencies
.env.example                 Configuration reference, with no real secrets
.gitignore                   Excludes local keys, databases and caches
templates/                   Login, dashboard and administrator pages
static/dashboard.js          ROS transport, telemetry and movement controls
static/admin.js              CSRF-protected account actions
static/styles.css            Compiled local styles
static/input.css             Source styles
tailwind.config.cjs          CSS theme and template discovery
static/vendor/               ROSLIB and third-party license files
tests/                       Backend and simulated movement regression tests
.github/workflows/tests.yml  GitHub test workflow
```

## Upload to GitHub

1. Create an empty repository named `humac-robot-dashboard` at <https://github.com/new>. Start with **Private**. Do not initialize it with another README, `.gitignore` or license.
2. Open a terminal in this project's folder, then run:

   ```bash
   git init -b main
   git add .
   git status --short
   git diff --cached
   ```

3. Review the staged content. `harvester.db`, `.env`, `.venv` and real credentials must not appear. `.env.example` is safe to include because it contains no key.
4. Commit and push, replacing `YOUR_USERNAME` with your GitHub username:

   ```bash
   git commit -m "Initial commit: HUMAC robot dashboard"
   git remote add origin https://github.com/YOUR_USERNAME/humac-robot-dashboard.git
   git push -u origin main
   ```

Use your configured GitHub authentication. If HTTPS asks for a password, use a suitable personal access token or a credential manager, not your GitHub account password. The repository includes a workflow, so your token may also need permission to write workflow files. Never paste a token into a repository file or remote URL.

After uploading, inspect the repository's file list and **Actions** tab. To upload later edits: review changes, then `git add`, `git commit` and `git push` again. Publishing source code does not host the running dashboard.

Official guide: [Adding locally hosted code to GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github).
