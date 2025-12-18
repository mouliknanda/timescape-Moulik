// A Tesseract in P5.js (4D to 3D Projection) - OPTIMIZED

let angle = 0;
let points = [];
let hueVal = 0;
let video;
let handPose;
let hands = [];
let modelStatus = "Loading Model...";
// Snapshot States
const SNAPSHOT_IDLE = 0;
const SNAPSHOT_ENTERING = 1; // Fade out background
const SNAPSHOT_ACTIVE = 2;   // Recording
const SNAPSHOT_EXITING = 3;  // Fade out trails, fade in background

let stars = [];

let showDebug = false;
let snapshotState = SNAPSHOT_IDLE;
let snapshotStart = 0;
let transitionStart = 0;
let snapshotCooldown = 0; // Cooldown to prevent spamming snapshots
let fistHoldStart = 0; // Timer for gesture hold
let activeFistHand = null; // Track which hand is holding the fist
let snapshotCounter = 1; // Persistent snapshot counter

let handPresenceLevel = 0; // 0-100, smooth fade based on hand tracking

let sceneOpacity = 100; // 0-100 (HSB Alpha)
let artLayer; // Off-screen buffer for clean snapshots

// UI Cache Variables (Optimization)
let uiHud, uiStatus, uiRec;
let prevStatus = "";

// Configuration
const distance = 2; // Distance of the "4D camera"
let scaleFactor = 150; // Size on screen
let prevScaleFactor = 150; // For warp calculation
const snapshotMultiplier = 2; // Capture 2x the screen size (for out-of-bounds trails)

// Interaction State (for smooth transitions)
let camRotX = 0;
let camRotY = 0;
let camRotZ = 0;

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  colorMode(HSB, 360, 100, 100, 100);
  scaleFactor = min(width, height) / 4;

  // Setup video and handPose
  // Request HD resolution (1280x720) or best available
  video = createCapture({
    audio: false,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  });
  video.hide(); // Hide the default element so it doesn't show up at the bottom
  handPose = ml5.handPose(video, { flipped: true }, modelLoaded);

  // Initialize off-screen buffer (Expanded Canvas)
  artLayer = createGraphics(width * snapshotMultiplier, height * snapshotMultiplier, WEBGL);
  artLayer.colorMode(HSB, 360, 100, 100, 100);
  artLayer.clear();

  // --- OPTIMIZATION: Cache DOM Elements once ---
  uiHud = select('#hud');
  uiStatus = select('#model-status');
  uiRec = select('#recording-indicator');

  // Generate the 16 vertices of a hypercube
  for (let i = 0; i < 16; i++) {
    let x = (i & 1) ? 1 : -1;
    let y = (i & 2) ? 1 : -1;
    let z = (i & 4) ? 1 : -1;
    let w = (i & 8) ? 1 : -1;
    points.push(new P4Vector(x, y, z, w));
  }

  // Generate Stars
  for (let i = 0; i < 200; i++) {
    stars.push({
      x: random(-width, width),
      y: random(-height, height),
      z: random(-1000, -500),
      brightness: random(100, 255)
    });
  }

  // Initialize Snapshot Counter from LocalStorage
  let storedCounter = localStorage.getItem('timescape_snapshot_counter');
  if (storedCounter !== null) {
    snapshotCounter = parseInt(storedCounter);
  }
}

function draw() {
  video.loadPixels();

  // --- STATE MACHINE UPDATE ---
  if (snapshotState === SNAPSHOT_ENTERING) {
    let elapsed = millis() - transitionStart;
    let duration = 1000;
    sceneOpacity = map(elapsed, 0, duration, 100, 0, true);

    if (elapsed >= duration) {
      snapshotState = SNAPSHOT_ACTIVE;
      snapshotStart = millis();
      artLayer.clear();
    }
  } else if (snapshotState === SNAPSHOT_EXITING) {
    let elapsed = millis() - transitionStart;
    let duration = 2000;
    sceneOpacity = map(elapsed, 0, duration, 0, 100, true);

    if (elapsed >= duration) {
      snapshotState = SNAPSHOT_IDLE;
      artLayer.clear();
    }
  } else if (snapshotState === SNAPSHOT_ACTIVE) {
    sceneOpacity = 0;
    let elapsed = millis() - snapshotStart;
    if (elapsed > 10000) {
      let filename = 'timescape_' + (1000 + snapshotCounter) + '.png';
      artLayer.save(filename);

      snapshotCounter++;
      localStorage.setItem('timescape_snapshot_counter', snapshotCounter);

      snapshotState = SNAPSHOT_EXITING;
      transitionStart = millis();
    }
  } else {
    sceneOpacity = 100;
  }

  // --- RENDERING ---

  // 1. Background / Clearing
  if (snapshotState === SNAPSHOT_ACTIVE || snapshotState === SNAPSHOT_ENTERING) {
    background(0);
  } else {
    push();
    translate(0, 0, 0);
    noStroke();
    fill(0, 0, 0, 10); // Trail fade
    resetMatrix();
    camera(0, 0, (height / 2.0) / tan(PI * 30.0 / 180.0), 0, 0, 0, 0, 1, 0);
    plane(width * 2, height * 2);
    pop();
  }

  drawingContext.clear(drawingContext.DEPTH_BUFFER_BIT);

  // 2. Draw Snapshot Art Layer
  if (snapshotState === SNAPSHOT_ACTIVE) {
    if (hands.length > 0) {
      drawTesseract(artLayer);
    }
    push();
    resetMatrix();
    // Draw the expanded artLayer centered on the screen
    // We offset by negative half width/height of the LAYER, not the screen
    image(artLayer, -width * snapshotMultiplier / 2, -height * snapshotMultiplier / 2, width * snapshotMultiplier, height * snapshotMultiplier);
    pop();
  } else if (snapshotState === SNAPSHOT_EXITING) {
    let artAlpha = map(sceneOpacity, 0, 100, 100, 0);
    push();
    resetMatrix();
    tint(255, artAlpha);
    image(artLayer, -width * snapshotMultiplier / 2, -height * snapshotMultiplier / 2, width * snapshotMultiplier, height * snapshotMultiplier);
    pop();
  }

  // 3. Draw Background Elements (Stars)
  let zoomSpeed = scaleFactor - prevScaleFactor;
  prevScaleFactor = scaleFactor;

  if (sceneOpacity > 0) {
    drawStars(sceneOpacity, zoomSpeed);
  }

  // 4. Interaction & Hands
  updateInteraction();

  // Smooth Hand Presence Level
  // If hands detected, fade in fast. If lost, fade out slow.
  let targetPresence = (hands.length > 0) ? 100 : 0;
  if (targetPresence > handPresenceLevel) {
    handPresenceLevel = lerp(handPresenceLevel, targetPresence, 0.2); // Fast fade in
  } else {
    handPresenceLevel -= 2; // Slow linear fade out (approx 1 sec from 100 to 0 @ 60fps)
  }
  handPresenceLevel = constrain(handPresenceLevel, 0, 100);

  // Combined Opacity for Draw
  // sceneOpacity handles Snapshot transitions. handPresenceLevel handles tracking loss.
  let finalOpacity = (sceneOpacity / 100) * (handPresenceLevel / 100) * 100;

  if (finalOpacity > 0.5) {
    if (hands.length > 0) {
      drawHands(finalOpacity);
      // Draw Progress Circle only if actively holding fist and hands are tracked
      if (fistHoldStart > 0 && activeFistHand) {
        drawFistProgress(activeFistHand);
      }
    } else {
      // Optional: Can verify if we want to show "ghost" hands fading out.
      // User asked for Tesseract fade out. Usually hands fading out too looks better.
      // We can draw hands using the LAST KNOWN positions if we wanted, but 'hands' array is empty when lost.
      // So we can't draw hands if hands.length == 0 unless we cache them.
      // For now, let's just let the Tesseract fade out. The Hands will disappear instantly (as they are the input),
      // but the Tesseract (the output) will linger.
    }
  }

  // 5. Draw Tesseract (Live View)
  if (snapshotState !== SNAPSHOT_ACTIVE) {
    if (finalOpacity > 0.5) {
      drawingContext.clear(drawingContext.DEPTH_BUFFER_BIT);
      // Pass the smooth opacity
      // We don't pass 'null' for pg?? Wait, drawTesseract check: function drawTesseract(pg, opacity = 100)
      drawTesseract(null, finalOpacity);
    }
  }

  // Only allow Orbit Control if completely idle and fully faded out
  // This prevents the camera from snapping back to mouse control while fading out
  if (snapshotState === SNAPSHOT_IDLE && hands.length === 0 && handPresenceLevel <= 0.5) {
    orbitControl();
  }

  // --- HTML UI UPDATE (Optimized) ---
  updateHtmlUi();
}

function updateHtmlUi() {
  // 1. Toggle HUD visibility (Only update class if changed)
  if (showDebug && uiHud.hasClass('hidden')) {
    uiHud.removeClass('hidden');
  } else if (!showDebug && !uiHud.hasClass('hidden')) {
    uiHud.addClass('hidden');
  }

  // 2. Update Status Text (Only if text changed)
  if (modelStatus !== prevStatus) {
    uiStatus.html(modelStatus);
    prevStatus = modelStatus;
  }

  // 3. Update Recording Indicator
  if (snapshotState === SNAPSHOT_ACTIVE) {
    if (uiRec.hasClass('hidden')) uiRec.removeClass('hidden');
  } else {
    if (!uiRec.hasClass('hidden')) uiRec.addClass('hidden');
  }
}

function drawStars(opacity, zoomSpeed) {
  push();

  // --- OPTIMIZATION: Limited Neighbor Check ---
  strokeWeight(1);

  // Use squared distance threshold to avoid sqrt() (150 * 150 = 22500)
  const distThresholdSq = 22500;

  for (let i = 0; i < stars.length; i++) {
    let s1 = stars[i];

    // Update Z based on Warp
    s1.z += zoomSpeed * 4;
    if (s1.z > 0) s1.z = -1000;
    if (s1.z < -1000) s1.z = 0;

    // OPTIMIZATION: Only check next 5 stars, not ALL stars
    let checkLimit = min(i + 6, stars.length);

    for (let j = i + 1; j < checkLimit; j++) {
      let s2 = stars[j];

      // Manual distance squared calculation
      let dSq = (s1.x - s2.x) ** 2 + (s1.y - s2.y) ** 2 + (s1.z - s2.z) ** 2;

      if (dSq < distThresholdSq) {
        let d = Math.sqrt(dSq); // Only calc sqrt if we draw
        let flicker = random(0.5, 1);
        let lineAlpha = map(d, 0, 150, 50, 0) * (opacity / 100) * flicker;
        stroke(200, 50, 100, lineAlpha);
        line(s1.x, s1.y, s1.z, s2.x, s2.y, s2.z);
      }
    }

    // Draw Stars
    let b = s1.brightness + random(-20, 20);
    let finalB = map(b, 0, 255, 0, 100);
    fill(finalB, opacity);

    // Hyperspace Warp vs Static Point
    if (abs(zoomSpeed) > 0.5) {
      // Keep line for warp effect
      stroke(finalB, opacity);
      strokeWeight(2);
      let streakLen = zoomSpeed * 10;
      line(s1.x, s1.y, s1.z, s1.x, s1.y, s1.z - streakLen);
    } else {
      // OPTIMIZATION: Use point() instead of sphere()
      stroke(finalB, opacity);
      strokeWeight(3);
      point(s1.x, s1.y, s1.z);
    }
  }
  pop();
}

function updateInteraction() {
  let targetRotX = 0;
  let targetRotY = 0;
  let targetRotZ = 0;
  let newScale = scaleFactor;

  if (hands.length > 0) {
    let sumX = 0;
    let sumY = 0;
    for (let hand of hands) {
      let indexTip = hand.keypoints[8];
      sumX += indexTip.x;
      sumY += indexTip.y;
    }
    let centerX = sumX / hands.length;
    let centerY = sumY / hands.length;

    targetRotY = map(centerX, 0, video.width, -PI, PI);
    targetRotX = map(centerY, 0, video.height, -PI, PI);

    if (hands.length >= 2) {
      let h1 = hands[0].keypoints[8];
      let h2 = hands[1].keypoints[8];
      let d = dist(h1.x, h1.y, h2.x, h2.y);
      newScale = map(d, 50, 400, 50, 400);
      scaleFactor = lerp(scaleFactor, newScale, 0.1);
      let angleBetween = atan2(h2.y - h1.y, h2.x - h1.x);
      targetRotZ = angleBetween;
    }

    camRotX = lerp(camRotX, targetRotX, 0.1);
    camRotY = lerp(camRotY, targetRotY, 0.1);
    camRotZ = lerp(camRotZ, targetRotZ, 0.1);

    // 3. GESTURE DETECTION (Snapshot Trigger)
    // Check if cooldown has passed
    if (snapshotState === SNAPSHOT_IDLE && millis() > snapshotCooldown) {
      let fistDetected = false;

      for (let hand of hands) {
        if (detectFist(hand)) {
          fistDetected = true;
          break;
        }
      }

      if (fistDetected) {
        // Start timer if not started
        if (fistHoldStart === 0) {
          fistHoldStart = millis();
        }

        // Find which hand caused the trigger for visualization
        // (Just picking the first valid one if multiple)
        activeFistHand = null;
        for (let hand of hands) {
          if (detectFist(hand)) {
            activeFistHand = hand;
            break;
          }
        }

        // Check duration
        if (millis() - fistHoldStart > 3000) {
          // TRIGGER SNAPSHOT
          snapshotState = SNAPSHOT_ENTERING;
          transitionStart = millis();
          // Set cooldown (10s recording + 2s exit + 3s buffer = 15s)
          snapshotCooldown = millis() + 15000;
          fistHoldStart = 0; // Reset timer
          activeFistHand = null;
          console.log("Fist Held for 3s! Starting Snapshot...");
        }
      } else {
        // Reset timer if fist is released
        fistHoldStart = 0;
        activeFistHand = null;
      }
    }
  }
}

// Helper: Detect if hand is making a fist
function detectFist(hand) {
  let fingersConfimed = 0;

  // Check index (8), middle (12), ring (16), pinky (20)
  // Compare Tip to Palm distance vs PIP to Palm distance
  // Index: Tip 8, PIP 6. Palm is 0.
  // Middle: Tip 12, PIP 10
  // Ring: Tip 16, PIP 14
  // Pinky: Tip 20, PIP 18

  let palm = hand.keypoints[0];

  // Indices of Tips and PIPs
  const fingerIndices = [
    { tip: 8, pip: 6 },
    { tip: 12, pip: 10 },
    { tip: 16, pip: 14 },
    { tip: 20, pip: 18 }
  ];

  for (let f of fingerIndices) {
    let t = hand.keypoints[f.tip];
    let p = hand.keypoints[f.pip];

    let dTip = dist(t.x, t.y, palm.x, palm.y);
    let dPip = dist(p.x, p.y, palm.x, palm.y);

    // If Tip is closer to palm than PIP, finger is likely curled
    if (dTip < dPip) {
      fingersConfimed++;
    }
  }

  // If 3 or more fingers are curled, it's a fist
  return fingersConfimed >= 3;
}

function drawHands(opacity) {
  for (let hand of hands) {
    drawNeonHand(hand, opacity);
  }
}

function drawFistProgress(hand) {
  let wrist = hand.keypoints[0];
  let middleMCP = hand.keypoints[9];

  // Center of palm
  let cx = (wrist.x + middleMCP.x) / 2;
  let cy = (wrist.y + middleMCP.y) / 2;

  // Map to screen coords
  let wx = map(cx, 0, video.width, -width / 2, width / 2);
  let wy = map(cy, 0, video.height, -height / 2, height / 2);

  let progress = map(millis() - fistHoldStart, 0, 3000, 0, 1, true);

  push();
  translate(wx, wy, -50); // At palm depth

  // Draw Constellation Ring
  let radius = 120;
  let starCount = 12;
  let angleStep = TWO_PI / starCount;

  // Rotate the whole ring slowly

  strokeWeight(2);

  // Draw Stars
  for (let i = 0; i < starCount; i++) {
    let a = i * angleStep;
    let sx = cos(a) * radius;
    let sy = sin(a) * radius;

    stroke(0, 0, 100); // White
    fill(0, 0, 100);   // White

    // Pulse effect
    let sSize = 4 + sin(frameCount * 0.2 + i) * 2;
    circle(sx, sy, sSize);
  }

  // Draw Connecting Lines (Progress Bar) - Polygonal
  if (progress > 0) {
    stroke(200, 80, 100); // Blue
    strokeWeight(2);      // Thinner
    noFill();

    beginShape();

    // We want straight lines between stars.
    // Progress goes from 0 to 1.
    // Total segments = starCount.

    let totalSegments = starCount;
    let currentStep = progress * totalSegments;
    let fullSegments = Math.floor(currentStep);
    let partialStep = currentStep - fullSegments;

    // Draw full segments (Star to Star)
    for (let i = 0; i <= fullSegments; i++) {
      // If we are at the very end (progress=1), cap index
      let idx = min(i, starCount);
      let a = idx * angleStep;
      vertex(cos(a) * radius, sin(a) * radius);
    }

    // Draw partial segment (from last star to interpolated point on line to next star)
    if (progress < 1.0) {
      let startIdx = fullSegments;
      let endIdx = (fullSegments + 1); // Wrapping handled by logic if needed, but here a circle usually implies loop or end. 
      // Current logic is 0..TWO_PI. 

      let a1 = startIdx * angleStep;
      let a2 = endIdx * angleStep;

      let x1 = cos(a1) * radius;
      let y1 = sin(a1) * radius;
      let x2 = cos(a2) * radius;
      let y2 = sin(a2) * radius;

      let tipX = lerp(x1, x2, partialStep);
      let tipY = lerp(y1, y2, partialStep);

      vertex(tipX, tipY);
    }

    endShape();
  }

  pop();
}

function drawTesseract(pg, opacity = 100) {
  let ctx = pg ? pg : window;

  ctx.push();
  // --- METALLIC LIGHTING ---
  // Soft ambient light to ensure visibility
  ctx.ambientLight(60);
  // Bright white point light from the "front-right"
  ctx.pointLight(0, 0, 100, 200, -200, 500);
  // Blueish rim light from "back-left"
  ctx.pointLight(200, 30, 80, -200, 200, -200);

  ctx.rotateX(camRotX);
  ctx.rotateY(camRotY);
  ctx.rotateZ(camRotZ);

  angle += 0.02;

  let projected3D = [];

  for (let i = 0; i < points.length; i++) {
    let v = points[i];
    let rotated = rotateZW(v, angle);
    rotated = rotateXY(rotated, angle * 0.5);
    let wVal = 1 / (distance - rotated.w);
    let p = createVector(
      rotated.x * wVal,
      rotated.y * wVal,
      rotated.z * wVal
    );
    p.mult(scaleFactor);
    projected3D.push(p);

    ctx.push();
    ctx.translate(p.x, p.y, p.z);
    ctx.noStroke();

    // --- METALLIC MATERIAL (Vertices) ---
    // Silvery/Bluish white specular material
    if (opacity < 100) {
      // If fading out, basic fill
      ctx.fill(200, 10, 80, opacity);
    } else {
      ctx.specularMaterial(200, 10, 80);
      ctx.shininess(50);
    }

    ctx.sphere(6); // Slightly larger beads for specularity
    ctx.pop();
  }

  // --- SPACE THEMED LINES ---
  // Gradient from Cyan (200) to Purple (280) based on position/index
  ctx.strokeWeight(1); // Thinner lines

  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      if (i !== j) {
        let diff = i ^ j;
        if ((diff & (diff - 1)) == 0) {
          let a = projected3D[i];
          let b = projected3D[j];

          // Create a gradient color based on the vertex index and time
          // Oscillate between Cyan (190) and Purple (290)
          let wave = sin(frameCount * 0.02 + i * 0.5);
          let hueSpace = map(wave, -1, 1, 190, 290);

          // Saturation and Brightness can also pulse slightly
          let satSpace = map(cos(frameCount * 0.03 + j), -1, 1, 80, 100);
          let brightSpace = 100;

          ctx.stroke(hueSpace, satSpace, brightSpace, opacity);

          // --- DOUBLE PARALLEL LINES LOGIC ---
          // Calculate vector along the line
          let v = createVector(b.x - a.x, b.y - a.y, b.z - a.z);
          // Arbitrary up vector for cross product
          let up = createVector(0, 1, 0);

          // Calculate perpendicular offset
          let offset = v.cross(up);

          // Handle case where line is parallel to up vector
          if (offset.magSq() < 0.001) {
            offset = v.cross(createVector(0, 0, 1));
          }

          offset.normalize();
          offset.mult(4); // Spacing distance

          // Draw two parallel lines
          ctx.line(a.x + offset.x, a.y + offset.y, a.z + offset.z, b.x + offset.x, b.y + offset.y, b.z + offset.z);
          ctx.line(a.x - offset.x, a.y - offset.y, a.z - offset.z, b.x - offset.x, b.y - offset.y, b.z - offset.z);
        }
      }
    }
  }
  ctx.pop();
}

function keyPressed() {
  if (key === 'd' || key === 'D') {
    showDebug = !showDebug;
  }
  if (key === 's' || key === 'S') {
    if (snapshotState === SNAPSHOT_IDLE) {
      snapshotState = SNAPSHOT_ENTERING;
      transitionStart = millis();
    }
  }
}

function modelLoaded() {
  modelStatus = "Model Ready!";
  console.log("Model Loaded!");
  handPose.detectStart(video, gotHands);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  artLayer.resizeCanvas(windowWidth * snapshotMultiplier, windowHeight * snapshotMultiplier);
  scaleFactor = min(width, height) / 4;
}

function gotHands(results) {
  hands = results;
}

class P4Vector {
  constructor(x, y, z, w) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
}

function rotateZW(p, theta) {
  let newZ = p.z * Math.cos(theta) - p.w * Math.sin(theta);
  let newW = p.z * Math.sin(theta) + p.w * Math.cos(theta);
  return new P4Vector(p.x, p.y, newZ, newW);
}

function rotateXY(p, theta) {
  let newX = p.x * Math.cos(theta) - p.y * Math.sin(theta);
  let newY = p.x * Math.sin(theta) + p.y * Math.cos(theta);
  return new P4Vector(newX, newY, p.z, p.w);
}

function drawNeonHand(hand, opacity = 100) {
  let fingers = [
    [0, 1, 2, 3, 4],
    [0, 5, 6, 7, 8],
    [0, 9, 10, 11, 12],
    [0, 13, 14, 15, 16],
    [0, 17, 18, 19, 20]
  ];

  push();
  noFill();
  strokeCap(ROUND);
  strokeJoin(ROUND);

  let alphaScale = opacity / 100.0;

  strokeWeight(60);
  stroke(190, 100, 100, 1 * alphaScale);
  drawSkeleton(hand, fingers);

  strokeWeight(40);
  stroke(190, 100, 100, 2 * alphaScale);
  drawSkeleton(hand, fingers);

  strokeWeight(25);
  stroke(190, 100, 100, 4 * alphaScale);
  drawSkeleton(hand, fingers);

  strokeWeight(14);
  stroke(190, 80, 100, 10 * alphaScale);
  drawSkeleton(hand, fingers);

  strokeWeight(7);
  stroke(190, 0, 100, 20 * alphaScale);
  drawSkeleton(hand, fingers);

  pop();
}



function drawSkeleton(hand, fingers) {
  for (let finger of fingers) {
    beginShape();
    for (let i of finger) {
      let kp = hand.keypoints[i];
      // Map based on actual video dimensions
      let wx = map(kp.x, 0, video.width, -width / 2, width / 2);
      let wy = map(kp.y, 0, video.height, -height / 2, height / 2);
      vertex(wx, wy, -50);
    }
    endShape();
  }
}