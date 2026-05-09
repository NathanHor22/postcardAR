// --- Asset config ---
const ROOMS = [
    { glbPath: './room1.glb', audioPath: './room1theme.mp3' },
    { glbPath: './room2.glb', audioPath: null },
    { glbPath: './room3.glb', audioPath: null },
];

const ROTATION_SPEED  = 0.005;
const ANIM_DELAY      = 1.0;
const ANIM_DURATION   = 0.5;
const MODEL_SCALE     = 0.003;
const MODEL_Y_OFFSET  = 0.15;
const MAX_RECORD_MS   = 10000;
const SWITCH_DURATION = 0.25;

// --- State ---
let activeRoomIndex = 0;
let activeModel     = null;
let currentAudio    = null;
let isAudioPlaying  = false;
let trackerVisible  = false;
let modelsLoaded    = 0;

const loadedModels    = [null, null, null];
const customAudioUrls = [null, null, null];

let scaleAnim      = { running: false, startTime: 0, delay: ANIM_DELAY };
let roomSwitchAnim = { active: false, targetIndex: -1, startTime: 0 };
let mediaRecorder  = null;
let recordChunks   = [];
let recordTimeout  = null;
let isRecording    = false;
let overlayTimer   = null;

let recordCountdown         = 10;
let recordCountdownInterval = null;

// --- DOM refs ---
const overlay       = document.getElementById('scan-overlay');
const loadingGuide  = document.getElementById('loading-guide');
const scanGuide     = document.getElementById('scan-guide');
const hintBar       = document.getElementById('hint-bar');
const hintText      = document.getElementById('hint-text');
const recordOverlay = document.getElementById('record-overlay');
const recordCount   = document.getElementById('record-count');

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setAnimationLoop(render);
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => renderer.setSize(window.innerWidth, window.innerHeight));

// --- Zappar camera (rear-facing) ---
const camera = new ZapparThree.Camera();
ZapparThree.glContextSet(renderer.getContext());

// --- Scene ---
const scene = new THREE.Scene();
// Background assigned after camera.start() to avoid uninitialised purple texture
scene.background = null;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(0, 5, 5);
scene.add(dirLight);

// --- Camera permission ---
ZapparThree.permissionRequestUI().then((granted) => {
    if (granted) {
        camera.start();
        scene.background = camera.backgroundTexture;
    } else {
        ZapparThree.permissionDeniedUI();
    }
});

// --- Image tracker ---
const manager      = new ZapparThree.LoadingManager();
const imageTracker = new ZapparThree.ImageTrackerLoader(manager).load('./postcard.zpt');
const trackerGroup = new ZapparThree.ImageAnchorGroup(camera, imageTracker);
scene.add(trackerGroup);

// Pivot inside the anchor for Z-axis spin.
// Zappar writes trackerGroup's world matrix directly, so rotation on the pivot
// (a plain Group with no other rotations) gives a true world-Z turntable spin.
const modelPivot = new THREE.Group();
trackerGroup.add(modelPivot);

// --- Preload all room models ---
const gltfLoader = new THREE.GLTFLoader(manager);

function onModelLoaded(gltf, i) {
    const model = gltf.scene;
    model.scale.setScalar(0);
    model.position.y = MODEL_Y_OFFSET;
    model.rotation.x = Math.PI / 2;
    loadedModels[i] = model;

    // Show immediately if this is the currently selected room
    if (i === activeRoomIndex) setActiveRoom(i);

    modelsLoaded++;
    if (modelsLoaded === ROOMS.length) {
        // All rooms ready — switch overlay from loading to scan phase
        loadingGuide.classList.add('guide-hidden');
        scanGuide.classList.remove('guide-hidden');
    }
}

function onModelError(i, err) {
    console.error('Room', i, 'failed to load:', err);
    // Still advance the counter so the UI doesn't get stuck on loading
    modelsLoaded++;
    if (modelsLoaded === ROOMS.length) {
        loadingGuide.classList.add('guide-hidden');
        scanGuide.classList.remove('guide-hidden');
    }
}

ROOMS.forEach(({ glbPath }, i) => {
    gltfLoader.load(glbPath, (gltf) => onModelLoaded(gltf, i), undefined, (err) => onModelError(i, err));
});

// --- Room management ---
function setActiveRoom(index) {
    if (activeModel) modelPivot.remove(activeModel);
    stopAudio();

    activeRoomIndex = index;
    activeModel     = loadedModels[index];

    if (!activeModel) return;

    activeModel.scale.setScalar(0);
    modelPivot.rotation.z = 0;
    modelPivot.add(activeModel);

    scaleAnim.running = false;
    trackerVisible    = false;

    document.querySelectorAll('.room-btn').forEach((btn, i) => {
        btn.classList.toggle('active', i === index);
    });
}

// --- Scale animation (ease-out cubic) ---
function startScaleAnimation(delayOverride) {
    const delay = delayOverride !== undefined ? delayOverride : ANIM_DELAY;
    scaleAnim = { running: true, startTime: performance.now(), delay };
}

function updateScaleAnimation() {
    if (!scaleAnim.running || !activeModel) return;

    const elapsed = (performance.now() - scaleAnim.startTime) / 1000;
    if (elapsed < scaleAnim.delay) return;

    const t = Math.min((elapsed - scaleAnim.delay) / ANIM_DURATION, 1);
    activeModel.scale.setScalar(MODEL_SCALE * (1 - Math.pow(1 - t, 3)));

    if (t >= 1) scaleAnim.running = false;
}

// --- Room switch animation (scale down → swap → scale up) ---
function requestRoomSwitch(index) {
    if (index === activeRoomIndex) return;
    if (roomSwitchAnim.active) return;

    if (activeModel && trackerVisible && activeModel.scale.x > 0) {
        scaleAnim.running = false;
        roomSwitchAnim = { active: true, targetIndex: index, startTime: performance.now() };
    } else {
        const wasVisible = trackerVisible;
        setActiveRoom(index);
        if (wasVisible) {
            trackerVisible = true;
            startScaleAnimation(0);
            playAudio();
        }
    }
    updateHint();
}

function updateRoomSwitchAnimation() {
    if (!roomSwitchAnim.active || !activeModel) return;

    const elapsed = (performance.now() - roomSwitchAnim.startTime) / 1000;
    const t       = Math.min(elapsed / SWITCH_DURATION, 1);
    activeModel.scale.setScalar(MODEL_SCALE * Math.pow(1 - t, 2));

    if (t >= 1) {
        const wasVisible = trackerVisible;
        roomSwitchAnim.active = false;
        setActiveRoom(roomSwitchAnim.targetIndex);
        if (wasVisible) {
            trackerVisible = true;
            startScaleAnimation(0);
            playAudio();
        }
        updateHint();
    }
}

// --- Overlay ---
function showOverlay() { overlay.classList.remove('hidden'); }
function hideOverlay()  { overlay.classList.add('hidden'); }

// --- Hint bar ---
function updateHint() {
    const hasAudio = customAudioUrls[activeRoomIndex] !== null
                  || ROOMS[activeRoomIndex].audioPath !== null;
    if (customAudioUrls[activeRoomIndex]) {
        hintText.textContent = 'Tap anywhere to play your recording  ·  🎤 to re-record';
    } else if (hasAudio) {
        hintText.textContent = 'Tap anywhere to play audio  ·  🎤 to record your voice';
    } else {
        hintText.textContent = 'Tap 🎤 to record a 10-second voice note for this room';
    }
}

// --- Audio ---
function playAudio() {
    const src = customAudioUrls[activeRoomIndex] ?? ROOMS[activeRoomIndex].audioPath;
    if (!src) return;

    stopAudio();
    currentAudio = new Audio(src);
    currentAudio.onended = () => { isAudioPlaying = false; };
    currentAudio.play().catch(() => {});
    isAudioPlaying = true;
}

function stopAudio() {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
    }
    isAudioPlaying = false;
}

function toggleAudio() {
    if (isAudioPlaying) stopAudio();
    else playAudio();
}

// --- Tap anywhere on the canvas to toggle audio ---
renderer.domElement.addEventListener('click',    () => { if (trackerGroup.visible && activeModel) toggleAudio(); });
renderer.domElement.addEventListener('touchend', () => { if (trackerGroup.visible && activeModel) toggleAudio(); }, { passive: true });

// --- Voice recording ---
function showRecordOverlay() { recordOverlay.classList.remove('hidden'); }
function hideRecordOverlay() { recordOverlay.classList.add('hidden'); }

function startRecording() {
    if (isRecording) return;

    navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
            recordChunks = [];
            isRecording  = true;
            updateMicButton();

            // Countdown timer
            recordCountdown = 10;
            recordCount.textContent = recordCountdown;
            showRecordOverlay();
            recordCountdownInterval = setInterval(() => {
                recordCountdown--;
                recordCount.textContent = recordCountdown;
                if (recordCountdown <= 0) {
                    clearInterval(recordCountdownInterval);
                    recordCountdownInterval = null;
                }
            }, 1000);

            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = (e) => recordChunks.push(e.data);
            mediaRecorder.onstop = () => {
                const blob = new Blob(recordChunks, { type: mediaRecorder.mimeType });
                if (customAudioUrls[activeRoomIndex]) {
                    URL.revokeObjectURL(customAudioUrls[activeRoomIndex]);
                }
                customAudioUrls[activeRoomIndex] = URL.createObjectURL(blob);
                recordChunks = [];
                isRecording  = false;
                updateMicButton();
                stream.getTracks().forEach((t) => t.stop());
                updateHint();
            };

            mediaRecorder.start();
            recordTimeout = setTimeout(stopRecording, MAX_RECORD_MS);
        })
        .catch(() => {
            isRecording = false;
            updateMicButton();
        });
}

function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    clearTimeout(recordTimeout);
    clearInterval(recordCountdownInterval);
    recordCountdownInterval = null;
    hideRecordOverlay();
    mediaRecorder.stop();
}

function updateMicButton() {
    const btn = document.getElementById('mic-btn');
    btn.classList.toggle('recording', isRecording);
    btn.title = isRecording ? 'Stop recording' : 'Record voice note';
}

// --- UI listeners ---
document.querySelectorAll('.room-btn').forEach((btn) => {
    btn.addEventListener('click', () => requestRoomSwitch(Number(btn.dataset.room)));
});

document.getElementById('mic-btn').addEventListener('click', () => {
    if (isRecording) stopRecording();
    else startRecording();
});

// --- Render loop ---
function render() {
    camera.updateFrame(renderer);

    const isVisible = trackerGroup.visible;

    if (isVisible && !trackerVisible) {
        // Postcard just detected
        clearTimeout(overlayTimer);
        hideOverlay();
        startScaleAnimation();
        playAudio();
        updateHint();
        hintBar.classList.remove('hidden');
    }

    if (!isVisible && trackerVisible) {
        // Postcard just lost
        overlayTimer = setTimeout(showOverlay, 600);
        stopAudio();
        hintBar.classList.add('hidden');
    }

    trackerVisible = isVisible;

    updateRoomSwitchAnimation();

    if (isVisible && activeModel) {
        modelPivot.rotation.z += ROTATION_SPEED;
        updateScaleAnimation();
    }

    renderer.render(scene, camera);
}
