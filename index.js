// --- Asset config ---
const ROOMS = [
    { glbPath: './room1.glb', audioPath: './room1theme.mp3' },
    { glbPath: './room2.glb', audioPath: null },
    { glbPath: './room3.glb', audioPath: null },
];

const ROTATION_SPEED = 0.003;
const ANIM_DELAY     = 1.0;   // seconds before scale-in starts
const ANIM_DURATION  = 0.5;   // seconds for scale-in
const MODEL_SCALE    = 0.06;  // size relative to postcard — tweak if needed
const MODEL_Y_OFFSET = 0.15;  // how far above the postcard the model floats
const MAX_RECORD_MS  = 10000;

// --- State ---
let activeRoomIndex  = 0;
let activeModel      = null;
let currentAudio     = null;
let isAudioPlaying   = false;
let trackerVisible   = false;

const loadedModels    = [null, null, null];
const customAudioUrls = [null, null, null];

let scaleAnim     = { running: false, startTime: 0 };
let mediaRecorder = null;
let recordChunks  = [];
let recordTimeout = null;
let isRecording   = false;
let overlayTimer  = null;

// --- DOM refs ---
const overlay = document.getElementById('scan-overlay');

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
// Background is set after camera.start() so we never see the uninitialised purple texture
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
const manager = new ZapparThree.LoadingManager();
const imageTracker = new ZapparThree.ImageTrackerLoader(manager).load('./postcard.zpt');
const trackerGroup = new ZapparThree.ImageAnchorGroup(camera, imageTracker);
scene.add(trackerGroup);

// --- Preload all room models ---
const gltfLoader = new THREE.GLTFLoader(manager);

ROOMS.forEach(({ glbPath }, i) => {
    gltfLoader.load(glbPath, (gltf) => {
        const model = gltf.scene;
        model.scale.setScalar(0);
        model.position.y = MODEL_Y_OFFSET;
        loadedModels[i] = model;
        if (i === 0) setActiveRoom(0);
    });
});

// --- Room management ---
function setActiveRoom(index) {
    if (activeModel) trackerGroup.remove(activeModel);
    stopAudio();

    activeRoomIndex = index;
    activeModel = loadedModels[index];

    if (!activeModel) return;

    activeModel.scale.setScalar(0);
    trackerGroup.rotation.y = 0;
    trackerGroup.add(activeModel);

    scaleAnim.running = false;
    trackerVisible = false;

    document.querySelectorAll('.room-btn').forEach((btn, i) => {
        btn.classList.toggle('active', i === index);
    });
}

// --- Scale animation (ease-out cubic, targets MODEL_SCALE) ---
function startScaleAnimation() {
    scaleAnim = { running: true, startTime: performance.now() };
}

function updateScaleAnimation() {
    if (!scaleAnim.running || !activeModel) return;

    const elapsed = (performance.now() - scaleAnim.startTime) / 1000;
    if (elapsed < ANIM_DELAY) return;

    const t = Math.min((elapsed - ANIM_DELAY) / ANIM_DURATION, 1);
    activeModel.scale.setScalar(MODEL_SCALE * (1 - Math.pow(1 - t, 3)));

    if (t >= 1) scaleAnim.running = false;
}

// --- Overlay ---
function showOverlay() {
    overlay.classList.remove('hidden');
}

function hideOverlay() {
    overlay.classList.add('hidden');
}

// --- Audio ---
function playAudio() {
    const src = customAudioUrls[activeRoomIndex] ?? ROOMS[activeRoomIndex].audioPath;
    if (!src) return;

    stopAudio();
    currentAudio = new Audio(src);
    currentAudio.onended = () => { isAudioPlaying = false; };
    currentAudio.play();
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

// --- Tap to play (raycaster) ---
const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

function handleTap(event) {
    if (!trackerGroup.visible || !activeModel) return;

    const rect   = renderer.domElement.getBoundingClientRect();
    const source = event.changedTouches ? event.changedTouches[0] : event;
    pointer.set(
        ((source.clientX - rect.left) / rect.width)  * 2 - 1,
        -((source.clientY - rect.top)  / rect.height) * 2 + 1
    );

    raycaster.setFromCamera(pointer, camera);
    if (raycaster.intersectObjects(activeModel.children, true).length > 0) {
        toggleAudio();
    }
}

renderer.domElement.addEventListener('click', handleTap);
renderer.domElement.addEventListener('touchend', handleTap, { passive: true });

// --- Voice recording ---
function startRecording() {
    if (isRecording) return;

    navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
            recordChunks = [];
            isRecording  = true;
            updateMicButton();

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
    mediaRecorder.stop();
}

function updateMicButton() {
    const btn = document.getElementById('mic-btn');
    btn.classList.toggle('recording', isRecording);
    btn.title = isRecording ? 'Stop recording' : 'Record voice note';
}

// --- UI listeners ---
document.querySelectorAll('.room-btn').forEach((btn) => {
    btn.addEventListener('click', () => setActiveRoom(Number(btn.dataset.room)));
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
    }

    if (!isVisible && trackerVisible) {
        // Postcard just lost — show overlay again after a short delay to avoid flicker
        overlayTimer = setTimeout(showOverlay, 600);
    }

    trackerVisible = isVisible;

    if (isVisible) {
        trackerGroup.rotation.y += ROTATION_SPEED;
        updateScaleAnimation();
    }

    renderer.render(scene, camera);
}
