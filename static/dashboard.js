'use strict';

// This browser sends requests, never hardware safety guarantees or acknowledgements.
let ros = null;
let cmdVel = null;
let startMissionPub = null;
let subscriptions = [];
let isEStopActive = true;
let isManualOverrideEnabled = false;
let isHolding = false;
let isPermissionState = true;
let movementInterval = null;
const activeKeys = new Set();
let pointerMotion = null;
const maxLogLines = 100;
const byId = id => document.getElementById(id);
const connected = () => Boolean(ros && ros.isConnected);
const canMove = () => connected() && isManualOverrideEnabled && !isEStopActive;

function logTerminal(message, level = 'INFO') {
    const row = document.createElement('div');
    const timestamp = new Date().toISOString().slice(11, 23);
    row.className = level === 'ERROR' || level === 'FATAL' ? 'text-alert font-bold' :
        level === 'WARN' ? 'text-yellow-400' : level === 'SUCCESS' ? 'text-green-400' : 'text-slate-300';
    row.textContent = `[${timestamp}] [${level}] ${String(message)}`;
    const logs = byId('ros-logs');
    logs.appendChild(row);
    while (logs.childNodes.length > maxLogLines) logs.removeChild(logs.firstChild);
    logs.scrollTop = logs.scrollHeight;
}

function publishMission(command) {
    if (!connected() || !startMissionPub) return false;
    startMissionPub.publish(new ROSLIB.Message({data: command}));
    return true;
}

function sendTwist(linear, angular) {
    // Check transport before every publish: roslib must never queue stale movement.
    if (!connected() || !cmdVel) return;
    if ((linear !== 0 || angular !== 0) && !canMove()) return;
    cmdVel.publish(new ROSLIB.Message({
        linear: {x: linear, y: 0, z: 0}, angular: {x: 0, y: 0, z: angular}
    }));
}

function stopRobot() {
    if (movementInterval !== null) clearInterval(movementInterval);
    movementInterval = null;
    activeKeys.clear();
    pointerMotion = null;
    byId('active-key-indicator').textContent = 'KEY: NONE';
    sendTwist(0, 0);
}

function updateSafetyUI() {
    const online = connected();
    byId('manual-override-toggle').checked = isManualOverrideEnabled;
    byId('manual-override-toggle').disabled = !online || isEStopActive;
    byId('main-body').classList.toggle('emergency-active', isEStopActive);
    byId('estop-btn').classList.toggle('estop-engaged', isEStopActive);
    byId('estop-text').textContent = isEStopActive ? 'RELEASE STOP' : 'E-STOP';
    byId('estop-btn').disabled = !online;
    byId('start-mission-btn').disabled = !online || isEStopActive || isManualOverrideEnabled;
    byId('hold-resume-btn').disabled = !online || isEStopActive || isManualOverrideEnabled || isPermissionState;
    document.querySelectorAll('[data-motion]').forEach(button => {
        button.disabled = !canMove();
        button.classList.toggle('d-pad-disabled', !canMove());
    });
}

function disableManual(sendCommand = true) {
    stopRobot();
    const wasEnabled = isManualOverrideEnabled;
    isManualOverrideEnabled = false;
    if (sendCommand && wasEnabled) publishMission('MANUAL_OFF');
    updateSafetyUI();
}

function toggleManualOverride() {
    const requested = byId('manual-override-toggle').checked;
    if (!requested || !connected() || isEStopActive) {
        disableManual();
        return;
    }
    stopRobot();
    if (publishMission('MANUAL_ON')) {
        isManualOverrideEnabled = true;
        logTerminal('MANUAL_ON sent. Hold WASD or a direction button to move.', 'WARN');
    }
    updateSafetyUI();
}

function toggleEStop() {
    if (!connected()) return;
    if (isEStopActive) {
        if (!window.confirm('Release the software stop? Clear the robot perimeter first.')) return;
        stopRobot();
        publishMission('RESET');
        isEStopActive = false;
        logTerminal('Software stop released locally. Press START MISSION to request a new mission.', 'WARN');
    } else {
        disableManual();
        isEStopActive = true;
        publishMission('RESET');
        logTerminal('Zero velocity and RESET sent. Verify the robot stopped; use the physical stop if needed.', 'FATAL');
    }
    updateSafetyUI();
}

function startMission() {
    if (!connected() || isEStopActive || isManualOverrideEnabled) return;
    stopRobot();
    if (publishMission('START')) logTerminal('START request sent to robot. Await telemetry.', 'INFO');
}

function toggleHoldResume() {
    if (!connected() || isEStopActive || isManualOverrideEnabled || byId('hold-resume-btn').disabled) return;
    stopRobot();
    const command = isHolding ? 'RESUME' : 'PAUSE';
    if (publishMission(command)) {
        isHolding = !isHolding;
        byId('hold-resume-text').textContent = isHolding ? 'CONTINUE' : 'PAUSE';
        logTerminal(`${command} request sent to robot. Await telemetry.`, 'INFO');
    }
}

function publishMovement() {
    if (!canMove()) {
        stopRobot();
        return;
    }
    let linear = 0, angular = 0;
    if (pointerMotion) [linear, angular] = pointerMotion;
    else {
        linear = (Number(activeKeys.has('w')) - Number(activeKeys.has('s'))) * 0.5;
        angular = (Number(activeKeys.has('a')) - Number(activeKeys.has('d'))) * 0.5;
    }
    sendTwist(linear, angular);
}

function beginMovement() {
    if (!canMove()) return;
    publishMovement();
    if (movementInterval === null) movementInterval = setInterval(publishMovement, 100);
}

function suspendControls() {
    disableManual();
    // Pause autonomous activity too when the operator leaves the page.
    if (connected() && !isEStopActive) {
        publishMission('PAUSE');
        isHolding = true;
        byId('hold-resume-text').textContent = 'CONTINUE';
    }
}

function showOffline() {
    isPermissionState = true;
    byId('manual-mode-badge').classList.add('hidden');
    byId('manual-mode-badge').classList.remove('flex');
    byId('status-indicator').classList.replace('bg-green-500', 'bg-red-500');
    byId('status-text').textContent = 'OFFLINE';
    byId('status-text').classList.remove('text-green-400');
    byId('video-stream').removeAttribute('src');
    byId('video-stream').classList.add('hidden');
    byId('video-placeholder').classList.remove('hidden');
    byId('video-live').textContent = 'NO SIGNAL';
    byId('val-state').textContent = 'UNKNOWN';
    byId('val-trees').textContent = '—';
    byId('val-gps').textContent = 'NO FIX';
    byId('val-fps').textContent = '—';
    updateSafetyUI();
}

function cleanupTransport() {
    disableManual();
    subscriptions.forEach(topic => topic.unsubscribe());
    subscriptions = [];
    if (connected()) {
        publishMission('RESET');
        if (cmdVel) cmdVel.unadvertise();
        if (startMissionPub) startMissionPub.unadvertise();
    }
    cmdVel = null;
    startMissionPub = null;
    const old = ros;
    ros = null; // Old callbacks cannot change the replacement connection's state.
    if (old) old.close();
}

function connectROS() {
    const host = byId('jetson-ip').value.trim();
    if (!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?)$/.test(host)) {
        logTerminal('Enter a robot IPv4 address or hostname, without a scheme or port.', 'ERROR');
        return;
    }
    if (window.location.protocol === 'https:') {
        logTerminal('This local robot uses ws:// and http://. HTTPS needs a TLS robot gateway; see README.', 'ERROR');
        return;
    }
    cleanupTransport();
    isEStopActive = true;
    isHolding = false;
    isPermissionState = true;
    byId('hold-resume-text').textContent = 'PAUSE';
    showOffline();
    if (typeof ROSLIB === 'undefined') {
        logTerminal('ROSLIB failed to load. Check the internet connection / local assets.', 'ERROR');
        return;
    }
    logTerminal(`Connecting to ws://${host}:9090...`);
    const connection = new ROSLIB.Ros();
    ros = connection;
    connection.on('connection', () => {
        if (ros !== connection) return;
        setupPubSub(connection);
        stopRobot();
        publishMission('RESET');
        byId('status-indicator').classList.replace('bg-red-500', 'bg-green-500');
        byId('status-text').textContent = 'CONNECTED';
        byId('status-text').classList.add('text-green-400');
        byId('video-stream').src = `http://${host}:8080/stream?topic=/camera/color/image_raw&type=ros_compressed&quality=30&width=320&height=240`;
        byId('video-stream').classList.remove('hidden');
        byId('video-placeholder').classList.add('hidden');
        updateSafetyUI();
        logTerminal('Connected; RESET requested. Explicitly release the software stop before operating.', 'WARN');
    });
    connection.on('error', () => {
        if (ros !== connection) return;
        cleanupTransport();
        isEStopActive = true;
        showOffline();
        logTerminal('Transport error. Controls disabled. Verify the robot has stopped.', 'ERROR');
    });
    connection.on('close', () => {
        if (ros !== connection) return;
        // The socket is gone: only clear local state, never queue a command.
        disableManual(false);
        cmdVel = null;
        startMissionPub = null;
        subscriptions = [];
        ros = null;
        isEStopActive = true;
        showOffline();
        logTerminal('Connection lost. Controls cleared. Robot-side command timeout must stop movement.', 'ERROR');
    });
    connection.connect(`ws://${host}:9090`);
}

function setupPubSub(connection) {
    cmdVel = new ROSLIB.Topic({ros: connection, name: '/cmd_vel', messageType: 'geometry_msgs/Twist'});
    startMissionPub = new ROSLIB.Topic({ros: connection, name: '/start_mission', messageType: 'std_msgs/String'});
    const subscribe = (name, messageType, callback) => {
        const topic = new ROSLIB.Topic({ros: connection, name, messageType});
        topic.subscribe(message => { if (ros === connection && connected()) callback(message); });
        subscriptions.push(topic);
    };
    subscribe('/current_state', 'std_msgs/String', msg => {
        const state = String(msg.data).toUpperCase();
        byId('val-state').textContent = state;
        const manual = /^4(?:\b|_)/.test(state) || /\bMANUAL\b/.test(state);
        byId('manual-mode-badge').classList.toggle('hidden', !manual);
        byId('manual-mode-badge').classList.toggle('flex', manual);
        isPermissionState = /^6(?:\b|_)/.test(state) || /\bPERMISSION\b/.test(state);
        isHolding = /^7(?:\b|_)/.test(state) || /\bPAUSED?\b/.test(state);
        byId('hold-resume-text').textContent = isHolding ? 'CONTINUE' : 'PAUSE';
        updateSafetyUI();

    });
    subscribe('/trees_done', 'std_msgs/Int32', msg => { byId('val-trees').textContent = String(msg.data); });
    subscribe('/gps/fix', 'sensor_msgs/NavSatFix', msg => {
        const valid = Number.isFinite(msg.latitude) && Number.isFinite(msg.longitude) &&
            Math.abs(msg.latitude) <= 90 && Math.abs(msg.longitude) <= 180 && (!msg.status || msg.status.status >= 0);
        byId('val-gps').textContent = valid ? `Lat: ${msg.latitude.toFixed(6)} / Lon: ${msg.longitude.toFixed(6)}` : 'NO FIX';
    });
    subscribe('/rosout_agg', 'rosgraph_msgs/Log', msg => {
        if (String(msg.name).includes('battery_monitor') || String(msg.msg).includes('Raw Threshold')) return;
        const levels = {2: 'INFO', 4: 'WARN', 8: 'ERROR', 16: 'FATAL'};
        if (levels[msg.level]) logTerminal(`[${msg.name}]: ${msg.msg}`, levels[msg.level]);
    });
}

// Pointer capture and keyboard controls share one repeat timer and one stop path.
document.querySelectorAll('[data-motion]').forEach(button => {
    button.addEventListener('pointerdown', event => {
        if (!canMove() || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        stopRobot();
        pointerMotion = button.dataset.motion.split(',').map(Number);
        button.setPointerCapture(event.pointerId);
        beginMovement();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave'].forEach(name =>
        button.addEventListener(name, stopRobot));
});
document.addEventListener('keydown', event => {
    if (!canMove() || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName))) return;
    const key = event.key.toLowerCase();
    if (!'wasd'.includes(key) || key.length !== 1) return;
    event.preventDefault();
    activeKeys.add(key);
    byId('active-key-indicator').textContent = `KEY: ${[...activeKeys].join('+').toUpperCase()}`;
    beginMovement();
});
document.addEventListener('keyup', event => {
    const key = event.key.toLowerCase();
    if (!activeKeys.has(key)) return;
    activeKeys.delete(key);
    if (!activeKeys.size && !pointerMotion) stopRobot();
    else if (canMove()) publishMovement();
});
window.addEventListener('blur', suspendControls);
window.addEventListener('pagehide', () => { suspendControls(); cleanupTransport(); });
window.addEventListener('beforeunload', suspendControls);
document.addEventListener('visibilitychange', () => { if (document.hidden) suspendControls(); });
document.querySelectorAll('form[data-logout]').forEach(form => form.addEventListener('submit', suspendControls));
byId('video-stream').addEventListener('load', () => { byId('video-live').textContent = 'STREAM'; });
byId('video-stream').addEventListener('error', () => {
    byId('video-live').textContent = 'NO SIGNAL';
    logTerminal('Video stream unavailable. Verify web_video_server on port 8080.', 'WARN');
});
// An MJPEG <img> does not expose reliable decoded frame timestamps to the browser.
// Report no FPS value rather than a misleading image-difference estimate.
byId('val-fps').textContent = 'N/A';
showOffline();

byId('connect-btn').addEventListener('click', connectROS);
byId('manual-override-toggle').addEventListener('change', toggleManualOverride);
byId('teleop-stop-btn').addEventListener('click', stopRobot);
byId('start-mission-btn').addEventListener('click', startMission);
byId('hold-resume-btn').addEventListener('click', toggleHoldResume);
byId('estop-btn').addEventListener('click', toggleEStop);
byId('clear-logs-btn').addEventListener('click', () => { byId('ros-logs').textContent = ''; });
