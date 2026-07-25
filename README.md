# video-meet

A production-ready, real-time video conferencing application built with React, Node.js, Express, Socket.IO, and WebRTC. Supports multi-participant video calls, passcode-protected rooms, in-meeting chat, reactions, hand raising, screen sharing, and admin controls — all running in Docker.

---

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Quick Start (Local Development)](#quick-start-local-development)
- [Running with Docker Compose](#running-with-docker-compose)
- [Environment Variables](#environment-variables)
- [Jenkins CI/CD Pipeline](#jenkins-cicd-pipeline)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
Browser
  │
  ▼
┌─────────────────────────────┐
│   nginx (port 80)            │   ← video-meet-client container
│   Serves React SPA           │
│   Proxies /api/      ──────► │──► video-meet-server:5001
│   Proxies /socket.io/ ─────► │──► video-meet-server:5001
└─────────────────────────────┘
          videomeet-net (Docker bridge)
```

Inside Docker Compose the two containers share the `videomeet-net` bridge network. The browser always talks to nginx on port 80; nginx forwards API and WebSocket traffic to the backend by service name (`server`), so no CORS issues arise in production.

---

## Features

- Multi-participant WebRTC video and audio calls
- Passcode-protected rooms
- Admin controls — remove participants, end meetings
- Real-time chat and emoji reactions
- Raise hand indicator
- Screen sharing
- Room statistics (participant count, chat messages, raised hands)
- Graceful disconnect handling (admin leaving ends the meeting for all)

---

## Project Structure

```
video-meet/
├── client/                      # React frontend
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Home.js          # Landing page
│   │   │   ├── CreateRoom.js    # Room creation form
│   │   │   ├── JoinRoom.js      # Room join form
│   │   │   └── VideoCall.js     # Main video call UI
│   │   ├── config.js            # Environment-aware API / Socket URL config
│   │   └── App.js               # React Router setup
│   ├── Dockerfile               # Multi-stage: Node builder → nginx runner
│   ├── nginx.conf               # SPA fallback + /api + /socket.io proxying
│   └── package.json
│
├── server/                      # Node.js + Express + Socket.IO backend
│   ├── index.js                 # Signaling server — rooms, WebRTC relay, chat
│   ├── Dockerfile               # Multi-stage: deps → minimal runtime
│   └── package.json
│
├── docker-compose.yml           # Production Compose (healthchecks, networks)
├── Jenkinsfile                  # CI/CD pipeline (10 stages)
├── .env.example                 # Environment variable template
├── .gitignore
└── README.md
```

---

## Prerequisites

| Tool | Minimum version | Purpose |
|------|----------------|---------|
| Node.js | 18 | Local development |
| npm | 9 | Package management |
| Docker | 24 | Container runtime |
| Docker Compose | v2 (plugin) | Multi-container orchestration |
| Git | 2.x | Source control |

---

## Quick Start (Local Development)

Run the backend and frontend separately without Docker.

**1. Clone the repository**

```bash
git clone https://github.com/your-org/video-meet.git
cd video-meet
```

**2. Start the backend**

```bash
cd server
npm install
node index.js
# Server listens on http://localhost:5001
```

**3. Start the frontend** (in a new terminal)

```bash
cd client
npm install
npm start
# React dev server at http://localhost:3000
```

The `client/src/config.js` file automatically detects `localhost` and points API calls to `http://localhost:5001`.

---

## Running with Docker Compose

Docker Compose builds both images and wires everything together in a single command.

**1. Create your environment file**

```bash
cp .env.example .env
# Edit .env if you need non-default ports or registry settings
```

**2. Build and start all services**

```bash
docker compose --env-file .env up -d --build
```

**3. Open the app**

```
http://localhost:80
```

**4. View logs**

```bash
# All services
docker compose logs -f

# Backend only
docker compose logs -f server

# Frontend only
docker compose logs -f client
```

**5. Stop everything**

```bash
docker compose down
```

**6. Stop and remove volumes / images**

```bash
docker compose down --volumes --rmi all
```

### Service URLs inside Docker

| Service | Internal address | Host address |
|---------|-----------------|--------------|
| Frontend (nginx) | `http://client:80` | `http://localhost:80` |
| Backend (Express) | `http://server:5001` | `http://localhost:5001` |
| Backend health | — | `http://localhost:5001/api/rooms` |
| Frontend health | — | `http://localhost:80/health` |

---

## Environment Variables

Copy `.env.example` to `.env` and adjust values for your environment. The table below describes every variable.

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_VERSION` | `latest` | Docker image tag (use a semver or git SHA in CI) |
| `NODE_ENV` | `production` | Backend runtime mode |
| `SERVER_PORT` | `5001` | Port the Express server binds to inside the container |
| `CLIENT_PORT` | `80` | Host port mapped to the nginx container |
| `CLIENT_ORIGIN` | `http://localhost:80` | CORS allowed origin sent by the backend |
| `REACT_APP_API_BASE` | `/api` | API base path baked into the React build |
| `REACT_APP_SOCKET_URL` | _(empty)_ | Socket.IO URL — empty means same-origin (recommended) |
| `DOCKER_REGISTRY` | _(empty)_ | Docker Hub username or private registry host |
| `DOCKER_CREDENTIALS_ID` | `docker-hub-credentials` | Jenkins credential ID for registry login |
| `GIT_REPO_URL` | _(empty)_ | Repository URL used by the Jenkinsfile checkout stage |
| `GIT_BRANCH` | `main` | Branch Jenkins builds |

> `REACT_APP_*` variables are baked into the static bundle at **image build time** via Docker `ARG`. Changing them after the image is built requires a rebuild.

---

## Jenkins CI/CD Pipeline

The `Jenkinsfile` at the project root defines a 10-stage declarative pipeline.

### Pipeline stages

| # | Stage | What it does |
|---|-------|-------------|
| 1 | **Checkout** | Shallow-clones the configured branch; prints commit info |
| 2 | **Install Server Dependencies** | `npm ci` inside `server/` |
| 3 | **Install Client Dependencies** | `npm ci` inside `client/` |
| 4 | **Server Tests** | Runs `npm test` in `server/` — marked UNSTABLE (not FAILED) until a real test suite is added |
| 5 | **Client Tests** | `react-scripts test --watchAll=false --passWithNoTests` |
| 6 | **Build React App** | `npm run build` — output archived as Jenkins artefact |
| 7 | **Build Docker Images** | `docker compose build --no-cache --parallel` |
| 8 | **Push Docker Images** | Pushes `:<BUILD_NUMBER>` and `:latest` tags — skipped if `PUSH_IMAGES=false` or registry not configured |
| 9 | **Deploy** | `docker compose down` then `docker compose up -d` — skipped if `DEPLOY=false` |
| 10 | **Health Checks** | `curl` the backend `/api/rooms` and frontend `/health` endpoints with retries |

### Post-build actions

- Dangling Docker images pruned (`docker image prune`)
- Success / failure summary banner printed to console
- On failure: containers are stopped automatically
- Workspace `.env` file removed after the build

### Jenkins setup checklist

1. Install plugins: **Pipeline**, **Git**, **Docker Pipeline**, **Credentials Binding**, **Timestamper**
2. Add a **Username/Password** credential with the ID matching `DOCKER_CREDENTIALS_ID` (default: `docker-hub-credentials`)
3. Set global environment variables in **Manage Jenkins → Configure System**:
   - `DOCKER_REGISTRY` — your Docker Hub username or registry hostname
   - `GIT_REPO_URL` — repository HTTPS clone URL
4. Create a **Pipeline** job, point it at this repository, and set the script path to `Jenkinsfile`
5. The Jenkins agent must have `docker`, `docker compose`, `git`, and Node.js 18+ available

### Triggering a build

| Method | How |
|--------|-----|
| Manual | Click **Build with Parameters** in the Jenkins UI |
| On push | Add a GitHub/GitLab webhook pointing to `http://<jenkins>/github-webhook/` |
| Scheduled | Add `triggers { cron('H 2 * * *') }` to the Jenkinsfile `options` block |

---

## API Reference

All endpoints are served by the Express backend on port 5001 (or proxied through nginx at `/api`).

### `POST /api/rooms`

Create a new room.

**Request body**

```json
{
  "roomId": "my-room-123",
  "passcode": "secret",
  "creatorName": "Alice",
  "creatorEmail": "alice@example.com",
  "meetingDate": "2026-08-01",
  "meetingTime": "10:00"
}
```

**Response `200`**

```json
{ "success": true, "room": { "id": "my-room-123", ... } }
```

---

### `GET /api/rooms`

List all active rooms (public metadata only — no passcodes).

**Response `200`**

```json
[
  {
    "id": "my-room-123",
    "creatorName": "Alice",
    "meetingDate": "2026-08-01",
    "meetingTime": "10:00",
    "participantCount": 3
  }
]
```

---

### `POST /api/rooms/:roomId/verify`

Verify a room passcode before joining.

**Request body**

```json
{ "passcode": "secret" }
```

**Response `200`** — passcode correct  
**Response `401`** — wrong passcode  
**Response `404`** — room not found

---

### Socket.IO events

The signaling server uses Socket.IO on the same port. Key client-emitted events:

| Event | Payload | Description |
|-------|---------|-------------|
| `join-room` | `{ roomId, passcode, participantName, participantEmail, isHost }` | Join a room |
| `offer` | `{ offer, targetId }` | Relay WebRTC offer to a peer |
| `answer` | `{ answer, targetId }` | Relay WebRTC answer to a peer |
| `ice-candidate` | `{ candidate, targetId }` | Relay ICE candidate |
| `toggle-video` | `{ isEnabled }` | Broadcast video state change |
| `toggle-audio` | `{ isEnabled }` | Broadcast audio state change |
| `send-chat-message` | `{ message }` | Send a chat message to the room |
| `send-reaction` | `{ reaction }` | Send an emoji reaction |
| `toggle-raise-hand` | `{ isRaised }` | Toggle raised-hand status |
| `admin-remove-participant` | `{ participantId }` | Admin: remove a participant |
| `admin-end-meeting` | — | Admin: end meeting for all |

---

## Troubleshooting

**Containers exit immediately after `docker compose up`**  
Check logs: `docker compose logs server`. Confirm the `.env` file exists and `SERVER_PORT=5001` matches the Dockerfile `EXPOSE` value.

**Frontend shows "Network Error" when calling the API**  
In Docker, the browser sends requests to nginx which proxies to the backend. Verify `nginx.conf` has `proxy_pass http://server:5001;` for `/api/` and `/socket.io/`. Confirm both containers are on the `videomeet-net` network: `docker network inspect videomeet-net`.

**Jenkins pipeline fails at "Build Docker Images"**  
Ensure the Jenkins agent has Docker socket access (`/var/run/docker.sock` mounted, or the agent runs as a user in the `docker` group). Verify `docker compose` v2 is available: `docker compose version`.

**Jenkins stage "Push Docker Images" is skipped**  
This is expected if `PUSH_IMAGES=false` (the default for local builds) or if `DOCKER_REGISTRY` / `DOCKER_CREDENTIALS_ID` are not set in Jenkins global configuration.

**`react-scripts test` hangs in CI**  
The `CI=true` environment variable and `--watchAll=false` flag are already set in the Jenkinsfile. If it still hangs, add `--forceExit` (already included in the pipeline command).

**Port 80 already in use on the host**  
Change `CLIENT_PORT` in your `.env` file (e.g. `CLIENT_PORT=8080`) and rerun `docker compose up -d`.
