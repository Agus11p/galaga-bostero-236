// gameengine.js
import { Player } from './player.js';
import { Enemy } from './enemy.js';
import { Bullet } from './bullet.js';
import { Boss } from './boss.js';
import { AudioManager } from '../audio.js';
import { VisualEffects, PowerUp, EnhancedParticle } from './effects.js';

export class GameEngine {
    constructor(state) {
        this.state = state;
        this.audio = new AudioManager();
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.isRunning = false;
        this.isPaused = false;

        this.player = null;
        this.bullets = [];
        this.enemies = [];
        this.particles = []; // active particles (references to pool items)
        this.powerUps = [];
        this.stars = [];

        this.visualEffects = new VisualEffects(this.ctx, this.canvas);

        this.score = 0;
        this.lives = 3;
        this.wave = 1;
        this.startTime = 0;

        this.killStreak = 0;
        this.powerUpActive = false;
        this.powerUpType = null;
        this.powerUpTimer = 0;

        this.lastTime = 0;
        this.enemyDirection = 1;
        this.enemyMoveTimer = 0;
        this.enemyMoveInterval = 1000;

        this.powerUpSpawnTimer = 0;
        this.powerUpSpawnInterval = 15000;

        // --- Particle system / pool settings ---
        this.PARTICLE_POOL_SIZE = 120;          // max total particle objects (pool size)
        this.MAX_PARTICLES_PER_EXPLOSION = 12; // max new active particles per explosion
        this.MAX_PARTICLES_PER_FRAME = 20;     // safety: don't activate more than this per frame
        this._particlePool = [];
        this._activeParticleCountThisFrame = 0;

        this._initParticlePool();

        // Bindings
        this.handleVisibilityChange = null;
    }

    // Initialize particle pool
    _initParticlePool() {
        this._particlePool.length = 0;
        for (let i = 0; i < this.PARTICLE_POOL_SIZE; i++) {
            // create lightweight particle object compatible with EnhancedParticle usage
            this._particlePool.push({
                inUse: false,
                x: 0,
                y: 0,
                vx: 0,
                vy: 0,
                life: 0,
                color: '#FFF',
                type: 'spark'
            });
        }
    }

    // Acquire a particle from pool or return null if none available
    _acquireParticle() {
        for (let i = 0; i < this._particlePool.length; i++) {
            const p = this._particlePool[i];
            if (!p.inUse) {
                p.inUse = true;
                return p;
            }
        }
        return null;
    }

    // Release particle back to pool
    _releaseParticle(p) {
        p.inUse = false;
    }

    // Smart explosion: activate up to MAX_PARTICLES_PER_EXPLOSION and cap per-frame activations
    createExplosion(x, y, color) {
        // screen shake
        this.visualEffects.shake(3, 150);

        // cap activations per frame
        this._activeParticleCountThisFrame = this._activeParticleCountThisFrame || 0;

        let created = 0;
        const allowedThisFrame = Math.max(1, this.MAX_PARTICLES_PER_FRAME - this._activeParticleCountThisFrame);
        const toCreate = Math.min(this.MAX_PARTICLES_PER_EXPLOSION, allowedThisFrame);

        for (let i = 0; i < toCreate; i++) {
            const p = this._acquireParticle();
            if (!p) break;

            // configure particle properties (randomized)
            const speed = Math.random() * 2 + 0.5;
            const angle = Math.random() * Math.PI * 2;
            p.x = x + (Math.random() - 0.5) * 10;
            p.y = y + (Math.random() - 0.5) * 10;
            p.vx = Math.cos(angle) * speed * (Math.random() * 1.5);
            p.vy = Math.sin(angle) * speed * (Math.random() * 1.5);
            p.life = 0.6 + Math.random() * 0.6; // life in seconds (shorter to free quickly)
            p.color = (Math.random() > 0.5) ? color : '#FFD700';
            p.type = (Math.random() > 0.7) ? 'spark' : 'explosion';

            this.particles.push(p);
            created++;
            this._activeParticleCountThisFrame++;
        }
        // if no particle created due to pool full, silently skip (prevents freeze)
        if (created === 0) {
            // optional: play a lighter effect sound or skip entirely
            return;
        }
    }

    start() {
        console.log("Game Started");
        this.resize();
        this.isRunning = true;
        this.isPaused = false;
        this.score = 0;

        const shieldLevel = this.state.data.inventory.upgrades.shield || 0;
        this.lives = 3 + shieldLevel;

        this.wave = 1;
        this.bullets = [];
        this.enemies = [];
        this.particles = [];
        this.powerUps = [];
        this.initStars();

        this.player = new Player(this);
        this.spawnWave();
        this.audio.playStart();

        this.startTime = Date.now();
        this.lastTime = 0;
        requestAnimationFrame((ts) => this.loop(ts));

        this.updateHUD();

        // Handle visibility
        this.handleVisibilityChange = () => {
            if (document.hidden && this.isRunning && !this.isPaused) {
                this.isPaused = true;
                window.dispatchEvent(new CustomEvent('gamepause'));
            }
        };
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    initStars() {
        this.stars = [];
        for (let i = 0; i < 100; i++) {
            this.stars.push({
                x: Math.random() * this.canvas.width,
                y: Math.random() * this.canvas.height,
                size: Math.random() * 2 + 1,
                speed: Math.random() * 2 + 0.5,
                color: Math.random() > 0.5 ? '#001489' : '#FFD700'
            });
        }
    }

    stop() {
        this.isRunning = false;
        if (this.handleVisibilityChange) {
            document.removeEventListener('visibilitychange', this.handleVisibilityChange);
            this.handleVisibilityChange = null;
        }
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        if (!this.isPaused) {
            this.lastTime = performance.now();
            requestAnimationFrame((ts) => this.loop(ts));
        }
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        if (this.player) {
            this.player.y = this.canvas.height - 100;
        }
    }

    spawnWave() {
        this.enemies = [];
        const rows = 4;
        const cols = 8;
        const startX = 50;
        const startY = 50;
        const padding = 60;

        this.enemyMoveInterval = Math.max(200, 1000 - (this.wave * 100));

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let type = 'green';
                if (r === 0) type = 'gold';
                else if (r === 1) type = 'red';
                else if (r === 2) type = 'blue';

                this.enemies.push(new Enemy(this, startX + c * padding, startY + r * padding, type));
            }
        }
    }

    loop(timestamp) {
        if (!this.isRunning) return;
        if (this.isPaused) return;

        if (!this.lastTime) this.lastTime = timestamp;
        let deltaTime = timestamp - this.lastTime;

        // guard against very large delta
        if (!isFinite(deltaTime) || deltaTime > 200) {
            this.lastTime = timestamp;
            requestAnimationFrame((ts) => this.loop(ts));
            return;
        }

        this.lastTime = timestamp;

        // reset per-frame counters
        this._activeParticleCountThisFrame = 0;

        this.update(deltaTime);
        this.draw();

        requestAnimationFrame((ts) => this.loop(ts));
    }

    update(deltaTime) {
        // convert ms to seconds for particle life decay consistency (particles life is seconds)
        const dtSeconds = deltaTime / 1000;

        if (!this.player) return;

        // Power-up Timer
        if (this.powerUpActive) {
            this.powerUpTimer -= deltaTime;
            this.updatePowerUpHUD();
            if (this.powerUpTimer <= 0) {
                this.powerUpActive = false;
                this.powerUpType = null;
                this.player.resetPowerUp();
                this.hidePowerUpHUD();
            }
        }

        // Stars
        for (let i = 0; i < this.stars.length; i++) {
            const star = this.stars[i];
            star.y += star.speed;
            if (star.y > this.canvas.height) {
                star.y = 0;
                star.x = Math.random() * this.canvas.width;
            }
        }

        // Particles (update and recycle)
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dtSeconds * 60; // keep motion similar across fps
            p.y += p.vy * dtSeconds * 60;
            // life is in seconds
            p.life -= dtSeconds * 1.8; // faster decay
            if (p.life <= 0 || !isFinite(p.x) || !isFinite(p.y)) {
                // remove from active list and release to pool
                this._releaseParticle(p);
                this.particles.splice(i, 1);
            }
        }

        // Visual Effects
        this.visualEffects.update(deltaTime);

        // Player trail
        const equippedTrail = this.state.data.inventory.equippedTrail;
        if (equippedTrail !== 'none') {
            this.visualEffects.addTrail(
                this.player.x,
                this.player.y + this.player.height,
                this.player.width,
                10,
                '#FFD700',
                equippedTrail
            );
        }

        // Power-up spawn
        this.powerUpSpawnTimer += deltaTime;
        if (this.powerUpSpawnTimer >= this.powerUpSpawnInterval) {
            
            this.powerUpSpawnTimer = 0;
        }

        // Update power-ups
        for (let i = this.powerUps.length - 1; i >= 0; i--) {
            const p = this.powerUps[i];
            p.update(deltaTime);
            if (p.markedForDeletion) this.powerUps.splice(i, 1);
        }

        // Power-up collision
        for (let i = this.powerUps.length - 1; i >= 0; i--) {
            const powerUp = this.powerUps[i];
            if (this.checkRectCollision(powerUp, this.player)) {
                powerUp.markedForDeletion = true;
                this.activatePowerUp(powerUp.type);
                this.audio.playTone(800, 'sine', 0.2);
                this.powerUps.splice(i, 1);
            }
        }

        // Player update
        this.player.update(deltaTime);

        // Bullets update
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            b.update(deltaTime);
            if (b.markedForDeletion) this.bullets.splice(i, 1);
        }

        // Enemies movement timer
        this.enemyMoveTimer += deltaTime;
        if (this.enemyMoveTimer > this.enemyMoveInterval) {
            this.enemyMoveTimer = 0;
            let hitEdge = false;
            for (let i = 0; i < this.enemies.length; i++) {
                const enemy = this.enemies[i];
                if ((enemy.x + enemy.width >= this.canvas.width - 20 && this.enemyDirection === 1) ||
                    (enemy.x <= 20 && this.enemyDirection === -1)) {
                    hitEdge = true;
                    break;
                }
            }

            if (hitEdge) {
                this.enemyDirection *= -1;
                for (let i = 0; i < this.enemies.length; i++) {
                    this.enemies[i].y += 20;
                }
            } else {
                for (let i = 0; i < this.enemies.length; i++) {
                    this.enemies[i].x += 20 * this.enemyDirection;
                }
            }
        }

        // Enemy Shooting (unchanged logic but optimized loops)
        if (this.enemies.length > 0) {
            const elapsedMinutes = (Date.now() - this.startTime) / 60000;
            const baseChance = 0.005 + (elapsedMinutes * 0.005);
            const waveMultiplier = 1 + (this.wave * 0.1);
            const shootChance = baseChance * waveMultiplier;
            const shotsPerFrame = Math.min(3, Math.floor(elapsedMinutes / 2) + 1);

            for (let s = 0; s < shotsPerFrame; s++) {
                if (Math.random() < shootChance && this.enemies.length > 0) {
                    const shooter = this.enemies[Math.floor(Math.random() * this.enemies.length)];
                    const bullet = new Bullet(shooter.x + shooter.width / 2, shooter.y + shooter.height, 5, false);
                    this.bullets.push(bullet);
                }
            }
        }

        // Collision detection (optimized)
        this.checkCollisions();

        // Wave clear
        if (this.enemies.length === 0) {
            this.wave++;
            this.spawnWave();
            this.updateHUD();
        }
    }

    checkCollisions() {
        // bullets vs enemies (player bullets)
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const bullet = this.bullets[i];
            if (bullet.markedForDeletion) continue;

            if (bullet.isPlayerBullet) {
                // Try to find a single enemy hit and break early
                for (let j = this.enemies.length - 1; j >= 0; j--) {
                    const enemy = this.enemies[j];
                    if (enemy.markedForDeletion) continue;
                    if (this.checkRectCollision(bullet, enemy)) {
                        bullet.markedForDeletion = true;

                        if (enemy instanceof Boss) {
                            enemy.takeDamage();
                            if (enemy.markedForDeletion) {
                                this.score += enemy.scoreValue;
                                this.state.addKill();
                                this.killStreak++;
                                this.checkPowerUp();
                                this.audio.playExplosion();
                                // explosion uses pool
                                this.createExplosion(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2, '#FFFFFF');
                                this.updateHUD();
                                // remove enemy from list
                                this.enemies.splice(j, 1);
                            } else {
                                this.audio.playTone(200, 'square', 0.05);
                            }
                        } else {
                            // Normal enemy killed
                            this.score += enemy.scoreValue;
                            this.state.addKill();
                            this.killStreak++;
                            this.checkPowerUp();
                            this.audio.playExplosion();
                            this.createExplosion(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2, enemy.color);
                            this.updateHUD();
                            // mark and remove enemy
                            enemy.markedForDeletion = true;
                            this.enemies.splice(j, 1);
                        }

                        break; // bullet processed, go to next bullet
                    }
                }
            } else {
                // enemy bullet hitting player
                if (this.checkRectCollision(bullet, this.player)) {
                    bullet.markedForDeletion = true;
                    this.handlePlayerHit();
                }
            }
        }

        // Enemy vs player collision (single pass)
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const enemy = this.enemies[i];
            if (enemy.markedForDeletion) continue;
            if (this.checkRectCollision(enemy, this.player)) {
                // remove enemy and handle player hit
                this.enemies.splice(i, 1);
                this.handlePlayerHit();
            }
        }
    }

    checkPowerUp() {
        if (this.killStreak > 0 && this.killStreak % 10 === 0) {
            this.activatePowerUp('rapidFire');
        }
    }

    activatePowerUp(type) {
        this.powerUpActive = true;
        this.powerUpType = type;
        this.powerUpTimer = 5000;
        this.player.applyPowerUp(type);

        // instantiate only a few particles for effect (use pool)
        for (let i = 0; i < 8; i++) {
            const p = this._acquireParticle();
            if (!p) break;
            p.x = this.player.x + this.player.width / 2;
            p.y = this.player.y + this.player.height / 2;
            const angle = Math.random() * Math.PI * 2;
            p.vx = Math.cos(angle) * (Math.random() * 1.2 + 0.4);
            p.vy = Math.sin(angle) * (Math.random() * 1.2 + 0.4);
            p.life = 0.6 + Math.random() * 0.6;
            p.color = '#00FF00';
            p.type = 'star';
            this.particles.push(p);
        }

        window.dispatchEvent(new CustomEvent('powerup', {
            detail: { type: type, name: type }
        }));

        this.showPowerUpHUD();
    }

    handlePlayerHit() {
        this.lives--;
        this.killStreak = 0;
        this.audio.playExplosion();
        this.createExplosion(this.player.x + this.player.width / 2, this.player.y + this.player.height / 2, '#FFD700');
        this.updateHUD();

        if (this.lives <= 0) {
            this.gameOver();
        } else {
            // small invuln or respawn handling could go here
            this.visualEffects.shake(6, 250);
        }
    }

    checkRectCollision(rect1, rect2) {
        return (
            rect1.x < rect2.x + rect2.width &&
            rect1.x + rect1.width > rect2.x &&
            rect1.y < rect2.y + rect2.height &&
            rect1.height + rect1.y > rect2.y
        );
    }

    draw() {
        const shakeOffset = this.visualEffects.getShakeOffset();
        this.ctx.save();
        this.ctx.translate(shakeOffset.x, shakeOffset.y);

        this.ctx.clearRect(-shakeOffset.x, -shakeOffset.y, this.canvas.width, this.canvas.height);

        // Stars
        for (let i = 0; i < this.stars.length; i++) {
            const star = this.stars[i];
            this.ctx.fillStyle = star.color;
            // subtle variation
            this.ctx.globalAlpha = 0.6 + (Math.random() * 0.4);
            this.ctx.beginPath();
            this.ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.globalAlpha = 1.0;
        }

        // Visual Effects (trails etc)
        this.visualEffects.draw();

        // Player
        if (this.player) this.player.draw(this.ctx);

        // Enemies
        for (let i = 0; i < this.enemies.length; i++) {
            this.enemies[i].draw(this.ctx);
        }

        // Bullets
        for (let i = 0; i < this.bullets.length; i++) {
            this.bullets[i].draw(this.ctx);
        }

        // Power-ups
        for (let i = 0; i < this.powerUps.length; i++) {
            this.powerUps[i].draw(this.ctx);
        }

        // Particles (draw active pool items)
        // Use simple rectangle draw to keep cost low
        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            this.ctx.fillStyle = p.color;
            this.ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
            // fast draw: fillRect cheaper than path arc for each particle
            this.ctx.fillRect(Math.round(p.x), Math.round(p.y), 3, 3);
            this.ctx.globalAlpha = 1.0;
        }

        this.ctx.restore();
    }

    updateHUD() {
        const scoreEl = document.getElementById('game-score');
        const livesEl = document.getElementById('game-lives');
        const waveEl = document.getElementById('game-wave');
        if (scoreEl) scoreEl.textContent = this.score;
        if (livesEl) livesEl.textContent = this.lives;
        if (waveEl) waveEl.textContent = this.wave;
    }

    updatePowerUpHUD() {
        const hud = document.getElementById('powerup-hud');
        const timer = document.getElementById('powerup-timer');
        const icon = document.getElementById('powerup-icon');
        const name = document.getElementById('powerup-name');

        if (hud && timer) {
            const seconds = (this.powerUpTimer / 1000).toFixed(1);
            timer.textContent = `${seconds}s`;

            const powerUpData = {
                shield: { icon: '🛡️', name: 'ESCUDO' },
                rapidFire: { icon: '🔥', name: 'FUEGO RÁPIDO' },
                multiShot: { icon: '✨', name: 'TRIPLE DISPARO' },
                slowMo: { icon: '⏱️', name: 'SLOW MOTION' }
            };

            if (this.powerUpType && powerUpData[this.powerUpType]) {
                icon.textContent = powerUpData[this.powerUpType].icon;
                name.textContent = powerUpData[this.powerUpType].name;
            }
        }
    }

    showPowerUpHUD() {
        const hud = document.getElementById('powerup-hud');
        if (hud) hud.classList.remove('hidden');
    }

    hidePowerUpHUD() {
        const hud = document.getElementById('powerup-hud');
        if (hud) hud.classList.add('hidden');
    }

    endGame() {
        this.gameOver();
    }

    gameOver() {
        this.stop();

        const endTime = Date.now();
        const durationSeconds = Math.floor((endTime - this.startTime) / 1000);
        const minutes = Math.floor(durationSeconds / 60);
        const seconds = durationSeconds % 60;
        const timeString = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

        const totalScore = this.score;
        const coins = Math.floor(totalScore / 2);

        const runData = {
            kills: this.score,
            score: totalScore,
            time: durationSeconds,
            timeString,
            bonus: 0,
            coins,
            wave: this.wave,
            date: new Date().toISOString()
        };
        localStorage.setItem('galaga_last_run', JSON.stringify(runData));

        this.state.addCoins(coins);
        this.state.addRun({
            score: totalScore,
            kills: this.score,
            time: durationSeconds,
            wave: this.wave,
            date: runData.date
        });
        this.state.save();

        window.dispatchEvent(new CustomEvent('gameover'));
    }
}
