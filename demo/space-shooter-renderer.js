const WORLD_WIDTH = 960;
const WORLD_HEIGHT = 620;
const ATLAS_PATH = "/assets/space-shooter-sprites.png";
const TILE_COUNT = 4;
const MAX_EFFECTS = 48;

const ATLAS = Object.freeze({
  player: [0, 0], scout: [1, 0], tank: [2, 0], swarm: [3, 0],
  friendly: [0, 1], hostile: [1, 1], fast: [2, 1], missile: [3, 1],
  muzzle: [0, 2], blastSmall: [1, 2], blast: [2, 2], blastLarge: [3, 2],
  blastBlue: [0, 3], blastPink: [1, 3], blastGold: [2, 3], crystal: [3, 3],
});

const GLYPHS = Object.freeze({
  player: { color:0x5ce1e6, points:[[0,-1],[0.42,-0.05],[0.24,0.28],[0.72,0.66],[0,0.4],[-0.72,0.66],[-0.24,0.28],[-0.42,-0.05]] },
  scout: { color:0x9caaff, points:[[0,1],[0.52,-0.12],[0.28,-0.48],[0,-0.18],[-0.28,-0.48],[-0.52,-0.12]] },
  tank: { color:0xffc86b, points:[[0,1],[0.64,0.48],[0.64,-0.48],[0,-1],[-0.64,-0.48],[-0.64,0.48]] },
  swarm: { color:0xe75aff, points:[[0,1],[0.8,-0.2],[0,-0.68],[-0.8,-0.2]] },
  friendly: { color:0xdaf8ff, points:[[0,-1],[0.45,-0.1],[0.22,0.74],[0,0.5],[-0.22,0.74],[-0.45,-0.1]] },
  hostile: { color:0xff7086, points:[[0,-0.8],[0.66,0],[0,0.8],[-0.66,0]] },
  fast: { color:0x5ce1e6, points:[[0,-1],[0.5,-0.05],[0.24,0.75],[0,0.55],[-0.24,0.75],[-0.5,-0.05]] },
  missile: { color:0xffc86b, points:[[0,-1],[0.35,-0.25],[0.23,0.55],[0,0.85],[-0.23,0.55],[-0.35,-0.25]] },
});

function tileTexture(THREE, source, tile) {
  const texture = source.clone();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  const inset = 1.25 / 1254;
  texture.repeat.set(1 / TILE_COUNT - inset * 2, 1 / TILE_COUNT - inset * 2);
  texture.offset.set(tile[0] / TILE_COUNT + inset, 1 - (tile[1] + 1) / TILE_COUNT + inset);
  texture.needsUpdate = true;
  return texture;
}

export function createSpaceShooterRenderer({ THREE, host, width = WORLD_WIDTH, height = WORLD_HEIGHT, onError = () => {} }) {
  let renderer = null;
  let scene = null;
  let camera = null;
  let sourceTexture = null;
  let atlasReady = false;
  let disposed = false;
  let elapsed = 0;
  const sprites = new Map();
  const glyphs = new Map();
  const lastPositions = new Map();
  const effects = [];
  const effectPool = [];
  const materials = new Map();
  const geometries = [];
  const backgroundObjects = [];

  function reportError(error) {
    if (!disposed) onError(error instanceof Error ? error : new Error(String(error)));
  }

  function addStars() {
    const values = [];
    let seed = 0x21a7f1;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    for (let i = 0; i < 170; i += 1) {
      values.push(random() * WORLD_WIDTH, random() * WORLD_HEIGHT, -30 - random() * 100);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    const material = new THREE.PointsMaterial({ color: 0xb7d8ff, size: 1.6, transparent: true, opacity: 0.68, sizeAttenuation: false });
    const stars = new THREE.Points(geometry, material);
    scene.add(stars);
    backgroundObjects.push(stars);
    geometries.push(geometry);
    materials.set("stars", material);
  }

  function createSprite(tileName, widthPx, heightPx, opacity = 1, additive = false) {
    const tile = ATLAS[tileName];
    if (!tile || !sourceTexture || !atlasReady) return null;
    const texture = tileTexture(THREE, sourceTexture, tile);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity,
      depthWrite: false,
      ...(additive ? { blending: THREE.AdditiveBlending } : {}),
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(widthPx, heightPx, 1);
    scene.add(sprite);
    materials.set(material, material);
    return sprite;
  }

  function removeEntity(id) {
    const sprite = sprites.get(id);
    if (!sprite) return;
    if (id.startsWith("enemy:")) lastPositions.set(id, { x:sprite.position.x, y:sprite.position.y });
    scene.remove(sprite);
    sprite.material.map?.dispose?.();
    sprite.material.dispose?.();
    materials.delete(sprite.material);
    sprites.delete(id);
  }

  function syncGlyph(entity, id, glyphName, widthPx, heightPx, z, rotation = 0) {
    const description = GLYPHS[glyphName];
    if (!description) return;
    let mesh = glyphs.get(id);
    if (!mesh) {
      const vertices = [];
      for (let index = 0; index < description.points.length; index += 1) {
        const current = description.points[index];
        const next = description.points[(index + 1) % description.points.length];
        vertices.push(0, 0, 0, current[0], current[1], 0, next[0], next[1], 0);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
      const material = new THREE.MeshBasicMaterial({ color:description.color, side:THREE.DoubleSide, transparent:true, opacity:0.94, depthWrite:false });
      mesh = new THREE.Mesh(geometry, material);
      mesh.scale.set(widthPx / 2, heightPx / 2, 1);
      scene.add(mesh);
      glyphs.set(id, mesh);
      geometries.push(geometry);
      materials.set(material, material);
    }
    mesh.position.set(entity.x, entity.y, z);
    mesh.rotation.z = rotation;
    mesh.scale.set(widthPx / 2, heightPx / 2, 1);
  }

  function removeGlyph(id) {
    const mesh = glyphs.get(id);
    if (!mesh) return;
    scene.remove(mesh);
    glyphs.delete(id);
    mesh.geometry.dispose?.();
    mesh.material.dispose?.();
    const geometryIndex = geometries.indexOf(mesh.geometry);
    if (geometryIndex >= 0) geometries.splice(geometryIndex, 1);
    materials.delete(mesh.material);
  }

  function syncEntity(entity, prefix, tileName, widthPx, heightPx, z, options = {}) {
    const id = `${prefix}:${entity.id}`;
    let sprite = sprites.get(id);
    if (!sprite) {
      sprite = createSprite(tileName, widthPx, heightPx, options.opacity ?? 1, options.additive ?? false);
      if (!sprite) return;
      sprites.set(id, sprite);
    }
    sprite.position.set(entity.x, entity.y, z);
    sprite.visible = options.visible ?? true;
    sprite.rotation.z = options.rotation ?? 0;
    if (options.pulse) {
      const pulse = 1 + Math.sin(elapsed * 13 + options.phase) * 0.09;
      sprite.scale.set(widthPx * pulse, heightPx * pulse, 1);
    } else {
      sprite.scale.set(widthPx, heightPx, 1);
    }
  }

  function releaseEffect(effect) {
    if (effect.sprite) {
      effect.sprite.visible = false;
      effectPool.push(effect.sprite);
    }
    if (effect.particles) {
      scene.remove(effect.particles);
      effect.particles.material.opacity = 0;
      effect.particles.geometry.dispose?.();
      effect.particles.material.dispose?.();
      const geometryIndex = geometries.indexOf(effect.particles.geometry);
      if (geometryIndex >= 0) geometries.splice(geometryIndex, 1);
      materials.delete(effect.particles.material);
    }
  }

  function addParticleBurst(x, y, size, color, z) {
    const vertices = [];
    for (let index = 0; index < 18; index += 1) {
      const angle = index / 18 * Math.PI * 2;
      const radius = size * (index % 3 === 0 ? 0.5 : 0.34);
      vertices.push(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.PointsMaterial({ color, size:4.2, transparent:true, opacity:0.96, sizeAttenuation:false, depthWrite:false });
    const particles = new THREE.Points(geometry, material);
    particles.position.set(x, y, z);
    scene.add(particles);
    geometries.push(geometry);
    materials.set(material, material);
    return particles;
  }

  function addEffect(tileName, x, y, size, duration, z, rotation = 0, color = 0xffc86b) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || effects.length >= MAX_EFFECTS) return;
    let sprite = effectPool.pop() || createSprite(tileName, size, size, 0.96, true);
    if (sprite) {
      const material = sprite.material;
      // Pool sprites may be reused for a different atlas cell; replace only their visual material.
      const tile = ATLAS[tileName];
      if (tile) {
        material.map?.dispose?.();
        material.map = tileTexture(THREE, sourceTexture, tile);
      }
      sprite.scale.set(size, size, 1);
      sprite.position.set(x, y, z);
      sprite.rotation.z = rotation;
      sprite.visible = true;
      material.opacity = 0.96;
    }
    const particles = addParticleBurst(x, y, size, color, z + 0.5);
    effects.push({ sprite, particles, start: elapsed, duration, size, x, y });
  }

  function syncEffects(events = []) {
    for (const event of Array.isArray(events) ? events : []) {
      if (event.type === "shot") {
        addEffect("muzzle", event.x, event.y - 8, 28, 0.13, 14);
      } else if (event.type === "enemy_shot") {
        const tileName = event.fast ? "blastGold" : "muzzle";
        addEffect(tileName, event.x, event.y, event.fast ? 20 : 13, 0.1, 13,
          Math.atan2(event.vy || 1, event.vx || 0) - Math.PI / 2);
      } else if (event.type === "enemy_destroyed") {
        const tileName = event.enemy_type === "tank" ? "blastLarge" : event.enemy_type === "swarm" ? "blastPink" : "blast";
        const position = lastPositions.get(`enemy:${event.enemy_id}`);
        addEffect(tileName, position?.x ?? WORLD_WIDTH / 2, position?.y ?? WORLD_HEIGHT / 2, 54, 0.42, 12, 0,
          event.enemy_type === "tank" ? 0xffc86b : event.enemy_type === "swarm" ? 0xe75aff : 0x5ce1e6);
        lastPositions.delete(`enemy:${event.enemy_id}`);
      } else if (event.type === "hit") {
        addEffect("blastBlue", event.player?.x ?? WORLD_WIDTH / 2, event.player?.y ?? WORLD_HEIGHT - 70, 72, 0.48, 18, 0, 0xff7086);
      }
    }
    for (let i = effects.length - 1; i >= 0; i -= 1) {
      const effect = effects[i];
      const age = elapsed - effect.start;
      if (age >= effect.duration) {
        effects.splice(i, 1);
        releaseEffect(effect);
        continue;
      }
      const progress = Math.max(0, age / effect.duration);
      if (effect.sprite) effect.sprite.material.opacity = (1 - progress) * 0.96;
      if (effect.particles) {
        effect.particles.material.opacity = (1 - progress) * 0.96;
        const scale = 0.25 + progress * 1.1;
        effect.particles.scale.set(scale, scale, 1);
      }
      const scale = effect.size * (0.58 + progress * 0.9);
      if (effect.sprite) effect.sprite.scale.set(scale, scale, 1);
    }
  }

  function syncGame(game) {
    const live = new Set();
    const track = (entity, prefix, tile, glyph, w, h, z, options) => {
      const id = `${prefix}:${entity.id}`;
      live.add(id);
      syncEntity(entity, prefix, tile, w, h, z, options);
      syncGlyph(entity, id, glyph, w, h, z + 0.5, options.rotation || 0);
    };
    if (game?.player) {
      const player = game.player;
      const blink = player.invincible_s > 0 && Math.floor(player.invincible_s * 12) % 2 === 0;
      track(player, "player", "player", "player", 54, 62, 30, { visible: !blink, pulse: !blink, phase: elapsed });
    }
    for (const enemy of game?.enemies || []) {
      const tile = enemy.type === "tank" ? "tank" : enemy.type === "swarm" ? "swarm" : "scout";
      track(enemy, "enemy", tile, tile, enemy.w * 1.7, enemy.h * 1.7, 20, { pulse: enemy.type === "tank", phase: enemy.phase || 0 });
    }
    for (const shot of game?.playerBullets || []) {
      track(shot, "friendly", "friendly", "friendly", 15, 39, 24);
    }
    for (const shot of game?.enemyBullets || []) {
      const tile = shot.sweep ? "missile" : shot.fast ? "fast" : "hostile";
      const fast = Boolean(shot.fast || shot.sweep);
      track(shot, "hostile", tile, tile, fast ? 18 : 16, fast ? 38 : 24, 25, {
        rotation: Math.atan2(shot.vx || 0, -(shot.vy || 1)),
      });
    }
    for (const id of sprites.keys()) if (!live.has(id)) removeEntity(id);
    for (const id of glyphs.keys()) if (!live.has(id)) removeGlyph(id);
  }

  try {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020711);
    camera = new THREE.OrthographicCamera(0, width, 0, height, 0.1, 250);
    camera.position.set(0, 0, 100);
    camera.updateProjectionMatrix();
    renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
    renderer.setSize(width, height, false);
    renderer.domElement.setAttribute?.("aria-label", "Three.js space shooter arena");
    renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    host.appendChild(renderer.domElement);
    addStars();
    sourceTexture = new THREE.TextureLoader().load(ATLAS_PATH, () => { atlasReady = true; }, undefined, reportError);
  } catch (error) {
    reportError(error);
  }

  function resize(nextWidth, nextHeight) {
    if (!renderer || disposed) return;
    width = Math.max(1, nextWidth);
    height = Math.max(1, nextHeight);
    renderer.setSize(width, height, false);
    // Preserve exact game coordinates, stretching only with the CSS-sized arena.
    camera.left = 0;
    camera.right = WORLD_WIDTH;
    camera.top = 0;
    camera.bottom = WORLD_HEIGHT;
    camera.updateProjectionMatrix();
  }

  function render(game, visualEvents, seconds = 0) {
    if (!renderer || !scene || disposed) return;
    elapsed = Number.isFinite(seconds) ? seconds : elapsed + 1 / 60;
    syncGame(game);
    syncEffects(visualEvents);
    try {
      renderer.render(scene, camera);
    } catch (error) {
      reportError(error);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const sprite of sprites.values()) scene?.remove(sprite);
    sprites.clear();
    for (const glyph of glyphs.values()) scene?.remove(glyph);
    glyphs.clear();
    lastPositions.clear();
    for (const effect of effects) scene?.remove(effect.sprite);
    effects.length = 0;
    for (const sprite of effectPool) scene?.remove(sprite);
    effectPool.length = 0;
    for (const object of backgroundObjects) scene?.remove(object);
    for (const geometry of geometries) geometry.dispose?.();
    for (const material of materials.values()) {
      material.map?.dispose?.();
      material.dispose?.();
    }
    materials.clear();
    sourceTexture?.dispose?.();
    renderer?.dispose?.();
    renderer?.domElement?.remove?.();
  }

  return { render, resize, dispose };
}
