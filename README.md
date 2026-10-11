# DICE DUO — Multiplayer Ludo & Authenticated Smart Remote

**DICE DUO** is a complete, production-minded Android Ludo game and companion **Smart Remote** built in a TypeScript monorepo (`React + Vite + Capacitor + Node.js + Express + Socket.IO + Supabase PostgreSQL`).

---

## 1. Architecture & Monorepo Layout

```text
dice-duo/
├── apps/
│   ├── mobile/                  # Ludo Android & Web App (React + Vite + TypeScript + Capacitor)
│   │   ├── android/             # Native Capacitor Android project (com.diceduo.ludo)
│   │   ├── capacitor.config.ts  # Capacitor Android packaging configuration
│   │   ├── vercel.json          # Vercel SPA deployment configuration
│   │   └── src/
│   │       ├── components/      # LudoBoard (15x15 original SVG) & DiceRoller (3D pip dice)
│   │       ├── utils/           # Web Audio SFX synthesizer & optional Supabase anon client
│   │       └── App.tsx          # Online multiplayer, Local Pass & Play / AI, Match History
│   ├── remote/                  # Separate Smart Remote Web App (React + Vite + TypeScript)
│   │   ├── vercel.json          # Vercel SPA deployment configuration
│   │   └── src/
│   │       └── App.tsx          # Room + PIN pairing, live telemetry, Random/Custom mode, 1–6 keypad
│   └── server/                  # Authoritative Multiplayer Backend (Node.js + Express + Socket.IO)
│       └── src/
│           ├── app.ts           # Express REST routes, Socket.IO auth, Zod validation, rate limiting
│           ├── roomManager.ts   # Authoritative room lifecycle, remote pairing, dice & bot turns
│           ├── security.ts      # CSPRNG dice (crypto.randomInt), HMAC sessions, sliding rate limiter
│           └── supabaseRepo.ts  # Server-only Supabase persistence with in-memory fallback
├── packages/
│   ├── game-engine/             # Pure deterministic Ludo rules & 15x15 coordinate topology
│   │   └── src/
│   │       ├── board.ts         # 52-track cells, 8 safe squares, 4 yards, 4 home paths
│   │       └── engine.ts        # Six rules, 3x-six forfeit, captures, exact finish, consent logic
│   └── shared/                  # Shared TypeScript interfaces, constants, and strict Zod schemas
├── supabase/
│   ├── config.toml              # Supabase local CLI configuration
│   └── migrations/
│       └── 20261011000000_initial_schema.sql # Profiles, settings, matches, match_players + RLS
├── .env.example                 # Placeholder environment variables template
├── render.yaml                  # Render free-tier Blueprint for the backend server
├── tsconfig.base.json           # Strict shared TypeScript configuration
└── package.json                 # npm workspaces root scripts
```

---

## 2. Authoritative Dice & Security Model

1. **Zero Client Trust**:
   - The `match:roll_dice` Socket.IO payload schema (`RollDicePayloadSchema`) uses `.strict()` and **only** accepts `{ roomCode }`. Any client attempting to pass a `value` field in `match:roll_dice` is immediately rejected with `INVALID_PAYLOAD`.
   - Every turn order check, legal move calculation, capture, safe-square immunity, three-sixes forfeit, and win condition is computed exclusively on the server using `@dice-duo/game-engine`.
2. **Random Mode (`RANDOM`)**:
   - Uses Node.js `crypto.randomInt(1, 7)` (cryptographically secure pseudo-random number generator) on the server to produce an unbiased result in `1..6`.
3. **Custom Testing Mode (`CUSTOM_TESTING`)**:
   - Disabled by default in public matchmaking rooms.
   - Cannot be activated unless **every human player** in the match has explicitly granted consent (`match:consent_custom_mode`). If any player revokes consent at any point, the room immediately reverts to `RANDOM` mode and clears any queued custom dice value.
   - When active, an unmistakable disclosure banner (`⚠️ CUSTOM TESTING MODE ACTIVE`) is broadcast and rendered on all player screens, and every roll generated in this mode is tagged with `mode: 'CUSTOM_TESTING'`.
   - An authenticated Smart Remote paired to the room via the 6-character **Room Code** and 4-digit **Pairing PIN** can select a dice value `1–6`, reset the selection, or trigger the roll.

---

## 3. Environment Variables

Copy `.env.example` to `apps/server/.env`, `apps/mobile/.env`, and `apps/remote/.env` as needed. **Never commit real keys or expose `SUPABASE_SERVICE_ROLE_KEY` to client apps.**

| Variable | Target | Description |
| :--- | :--- | :--- |
| `PORT` | `apps/server` | HTTP & Socket.IO listening port (default `4000`) |
| `CORS_ORIGINS` | `apps/server` | Comma-separated allowed origins in production |
| `SESSION_SECRET` | `apps/server` | Secret key used to sign HMAC-SHA256 player & remote session tokens |
| `SUPABASE_URL` | `apps/server` | Supabase project URL (optional; falls back to in-memory storage if omitted) |
| `SUPABASE_ANON_KEY` | `apps/server` | Supabase public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | `apps/server` | **Server-only** key used to write authoritative match results |
| `VITE_SERVER_URL` | `apps/mobile`, `apps/remote` | Backend URL in production/Android builds (leave empty in local Vite proxy dev) |
| `VITE_SUPABASE_URL` | `apps/mobile`, `apps/remote` | Optional Supabase URL for client profile/auth |
| `VITE_SUPABASE_ANON_KEY` | `apps/mobile`, `apps/remote` | Optional Supabase public anon key (never service_role!) |

---

## 4. Local Development (Windows PowerShell & macOS/Linux)

### Prerequisites
- **Node.js**: v20.x or v22.x LTS (`node -v`)
- **npm**: v10+ (`npm -v`)

### Step-by-Step Commands (Windows PowerShell)

```powershell
# 1. Clone the repository and enter the workspace
git clone https://github.com/mr0utkarsh/dice-duo.git
Set-Location dice-duo

# 2. Install all workspace dependencies
npm install

# 3. Copy example environment files (optional for local dev)
Copy-Item .env.example apps/server/.env
Copy-Item apps/mobile/.env.example apps/mobile/.env
Copy-Item apps/remote/.env.example apps/remote/.env

# 4. Build shared packages and verify typecheck + unit/integration tests
npm run build
npm run typecheck
npm run test

# 5. Start the authoritative backend server (Port 4000) in Terminal 1
npm run dev:server

# 6. Start the Ludo Mobile App (Port 5173) in Terminal 2
npm run dev:mobile

# 7. Start the Smart Remote App (Port 5174) in Terminal 3
npm run dev:remote
```

- **Ludo Mobile App**: `http://localhost:5173`
- **Smart Remote App**: `http://localhost:5174`
- **Backend Health Check**: `http://localhost:4000/api/health`

---

## 5. Building the Android APK (Windows PowerShell, Java & Android SDK)

### Required Android Toolchain on Windows
1. **Java JDK 17 or 21**: Install Eclipse Temurin JDK 17 (or Android Studio's bundled JBR) and set `JAVA_HOME`.
2. **Android Studio & Android SDK**:
   - Install **Android SDK Platform 34** (or 35) and **Android SDK Build-Tools** via Android Studio SDK Manager.
   - Default Windows SDK path: `$env:LOCALAPPDATA\Android\Sdk`.

### Exact Windows PowerShell Commands to Build a Debug APK

```powershell
# 1. Configure JAVA_HOME and ANDROID_HOME for your PowerShell session
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.13.11-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"

# 2. Set your production or LAN backend server URL for the Android WebView bundle
$env:VITE_SERVER_URL = "https://your-dice-duo-server.onrender.com"

# 3. Build shared packages, build the mobile web bundle, and sync Capacitor Android
npm run build
npm --workspace=@dice-duo/mobile run cap:sync

# 4. Build the installable Debug APK via Gradle Wrapper
Push-Location apps/mobile/android
.\gradlew.bat assembleDebug
Pop-Location

# 5. Locate the generated APK:
Get-Item apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk

# 6. (Optional) Install directly onto a connected Android phone or emulator via ADB:
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

You can also open the native project in Android Studio at any time with:
```powershell
npm --workspace=@dice-duo/mobile run cap:open:android
```

---

## 6. Testing & Quality Verification

Run all verification suites from the repository root:

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

- `@dice-duo/shared`: Validates RoomCode, DiceValue `1..6`, and strict rejection of client-supplied dice values on `RollDicePayloadSchema`.
- `@dice-duo/game-engine`: Unit tests for 2-player opposite color assignment, 6-to-exit-yard, 3-consecutive-sixes turn forfeiture, turn validation, non-safe captures + bonus roll, safe-square immunity (`0, 8, 13, 21, 26, 34, 39, 47`), exact home entry (`step 56`), win detection, and Custom Testing Mode consent/disclosure rules.
- `@dice-duo/server`: End-to-end Socket.IO integration tests covering authentication rejection, room creation/joining, Smart Remote PIN pairing, Custom Testing Mode consent enforcement, remote 1–6 dice queuing/resetting, and anti-spoofing validation.

---

## 7. Free-Tier Deployment Guide & Provider Limitations

### A. Supabase (PostgreSQL + Optional Auth)
1. Create a new project on [Supabase](https://supabase.com/).
2. Open the **SQL Editor** and run the contents of `supabase/migrations/20261011000000_initial_schema.sql`.
3. Copy your `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from **Project Settings → API**.
4. **Current Free Plan Limits**: Supabase's free plan includes 500 MB database storage and 50,000 monthly active users, is limited to 2 active free projects per organization, and **pauses after 7 days of inactivity** (can be unpaused from the dashboard).

### B. Backend Server on Render (`apps/server`)
1. Push this repository to GitHub and connect it to [Render](https://render.com/) as a **Web Service** (or use the included `render.yaml` Blueprint).
2. Set **Build Command**:
   ```bash
   npm install && npm --workspace=@dice-duo/shared run build && npm --workspace=@dice-duo/game-engine run build && npm --workspace=@dice-duo/server run build
   ```
3. Set **Start Command**:
   ```bash
   npm --workspace=@dice-duo/server run start
   ```
4. Configure environment variables (`SESSION_SECRET`, `CORS_ORIGINS`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
5. **Current Free Plan Limits**: Render's free Web Service tier provides 750 free instance hours/month, **spins down after 15 minutes of inactivity** (causing a 30–60 second cold start on the next request), and clears in-memory room state whenever the container sleeps or restarts (completed matches are persisted to Supabase).

### C. Frontend Apps on Vercel (`apps/mobile` & `apps/remote`)
1. Import the GitHub repository twice into [Vercel](https://vercel.com/):
   - Project 1 (`dice-duo-mobile`): set **Root Directory** to `apps/mobile`, and set `VITE_SERVER_URL` to your Render backend URL.
   - Project 2 (`dice-duo-remote`): set **Root Directory** to `apps/remote`, and set `VITE_SERVER_URL` to your Render backend URL.
2. Both directories include a preconfigured `vercel.json` that builds `@dice-duo/shared` and `@dice-duo/game-engine` automatically.
3. **Current Free Plan Limits**: Vercel Hobby is free for personal, non-commercial use with 100 GB bandwidth/month. Note that Vercel serverless functions do not host persistent Socket.IO WebSocket servers, which is why the stateful Socket.IO backend is hosted separately on Render.

---

## 8. Capturing Screenshots for Documentation

1. Start the stack locally (`npm run dev:server`, `npm run dev:mobile`, `npm run dev:remote`).
2. Open `http://localhost:5173` in Chrome DevTools Device Toolbar (select **Pixel 7** or **Galaxy S20 Ultra** portrait viewport `412 × 915`) to capture:
   - Lobby & Room Creation screen
   - Waiting Room with 6-character Room Code & 4-digit Smart Remote PIN
   - Active 15×15 Ludo Board with movable token rings & Custom Testing Mode disclosure banner
3. Open `http://localhost:5174` in a second mobile viewport to capture the **Smart Remote** paired screen with the 1–6 dice keypad and consent matrix.
