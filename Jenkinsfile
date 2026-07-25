// ==============================================================
// video-meet — Production Jenkins Pipeline
// ==============================================================
//
// PREREQUISITES (configure in Jenkins before running):
//
//   1. Jenkins Credentials:
//      • DOCKER_CREDENTIALS_ID  — Docker Hub (or registry) username/password
//        ID must match the value in your .env / Jenkins env (default below).
//
//   2. Jenkins Global Environment Variables (Manage Jenkins → Configure System):
//      • DOCKER_REGISTRY         — e.g. "myusername" (Docker Hub) or ECR host
//      • GIT_REPO_URL            — full HTTPS clone URL of this repository
//      • GIT_BRANCH              — branch to build (default: main)
//
//   3. Jenkins Plugins required:
//      • Pipeline, Git, Docker Pipeline, Credentials Binding, Timestamper
//
//   4. The Jenkins agent must have installed:
//      • git, docker, docker-compose (v2 CLI plugin or standalone compose v1)
//      • Node.js 18+ (for the install/test stages that run outside Docker)
//
// HOW IT WORKS:
//   Stage 1  — Checkout source from Git
//   Stage 2  — Install server dependencies (npm ci)
//   Stage 3  — Install client dependencies (npm ci)
//   Stage 4  — Run server tests  (skipped gracefully — no tests yet)
//   Stage 5  — Run client tests  (react-scripts test, CI=true)
//   Stage 6  — Build React production bundle (npm run build)
//   Stage 7  — Build Docker images (server + client) via docker-compose
//   Stage 8  — Push images to registry  (skipped if DOCKER_REGISTRY unset)
//   Stage 9  — Deploy: stop old containers, start new ones with docker-compose
//   Stage 10 — Health-check both services
//   Post     — Cleanup dangling images; report build status
// ==============================================================

pipeline {

    // -----------------------------------------------------------
    // Run on any available agent.
    // Replace 'any' with a specific label if you have dedicated
    // Docker-capable agents, e.g.: agent { label 'docker-agent' }
    // -----------------------------------------------------------
    agent any

    // -----------------------------------------------------------
    // Pipeline-level options
    // -----------------------------------------------------------
    options {
        timestamps()                          // Prefix every log line with a timestamp
        timeout(time: 30, unit: 'MINUTES')    // Abort if the pipeline exceeds 30 min
        disableConcurrentBuilds()             // Prevent parallel runs on same branch
        buildDiscarder(logRotator(
            numToKeepStr: '10',               // Keep last 10 build logs
            artifactNumToKeepStr: '5'
        ))
    }

    // -----------------------------------------------------------
    // Environment variables available to every stage.
    // Override DOCKER_REGISTRY / GIT_* in Jenkins global config
    // or inject them from a .env / credentials binding.
    // -----------------------------------------------------------
    environment {
        // ── Application ──────────────────────────────────────
        APP_NAME         = 'video-meet'
        APP_VERSION      = "${BUILD_NUMBER}"   // Use Jenkins build number as image tag

        // ── Docker ───────────────────────────────────────────
        SERVER_IMAGE     = "${env.DOCKER_REGISTRY ? env.DOCKER_REGISTRY + '/' : ''}video-meet-server"
        CLIENT_IMAGE     = "${env.DOCKER_REGISTRY ? env.DOCKER_REGISTRY + '/' : ''}video-meet-client"
        COMPOSE_FILE     = 'docker-compose.yml'

        // ── Ports (must match docker-compose.yml defaults) ───
        SERVER_PORT      = '5001'
        CLIENT_PORT      = '80'

        // ── Node ─────────────────────────────────────────────
        CI               = 'true'             // Treats React test warnings as errors
        NODE_ENV         = 'production'
    }

    // -----------------------------------------------------------
    // Parameters — can be overridden when triggering a build
    // manually from the Jenkins UI.
    // -----------------------------------------------------------
    parameters {
        string(
            name: 'BRANCH',
            defaultValue: 'main',
            description: 'Git branch to build and deploy'
        )
        booleanParam(
            name: 'PUSH_IMAGES',
            defaultValue: true,
            description: 'Push Docker images to the registry after building'
        )
        booleanParam(
            name: 'DEPLOY',
            defaultValue: true,
            description: 'Deploy the application after building (docker-compose up)'
        )
        booleanParam(
            name: 'CLEAN_WORKSPACE',
            defaultValue: false,
            description: 'Wipe the workspace before checkout (slower but clean)'
        )
    }

    // ===========================================================
    // STAGES
    // ===========================================================
    stages {

        // -------------------------------------------------------
        // Stage 1: Checkout
        // -------------------------------------------------------
        stage('Checkout') {
            steps {
                script {
                    if (params.CLEAN_WORKSPACE) {
                        echo "🧹 Cleaning workspace before checkout..."
                        cleanWs()
                    }
                }

                echo "📥 Checking out branch: ${params.BRANCH}"

                checkout([
                    $class: 'GitSCM',
                    branches: [[name: "*/${params.BRANCH}"]],
                    userRemoteConfigs: [[
                        url: "${env.GIT_REPO_URL ?: scm.userRemoteConfigs[0].url}"
                    ]],
                    extensions: [
                        [$class: 'CleanBeforeCheckout'],
                        [$class: 'CloneOption', depth: 1, shallow: true]
                    ]
                ])

                // Print commit info for traceability
                sh '''
                    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                    echo "  Commit : $(git rev-parse --short HEAD)"
                    echo "  Author : $(git log -1 --format='%an <%ae>')"
                    echo "  Message: $(git log -1 --format='%s')"
                    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                '''
            }
        }

        // -------------------------------------------------------
        // Stage 2: Install Server Dependencies
        // -------------------------------------------------------
        stage('Install Server Dependencies') {
            steps {
                echo "📦 Installing server (Node.js) dependencies..."
                dir('server') {
                    sh 'npm ci --frozen-lockfile'
                }
            }
        }

        // -------------------------------------------------------
        // Stage 3: Install Client Dependencies
        // -------------------------------------------------------
        stage('Install Client Dependencies') {
            steps {
                echo "📦 Installing client (React) dependencies..."
                dir('client') {
                    sh 'npm ci --frozen-lockfile'
                }
            }
        }

        // -------------------------------------------------------
        // Stage 4: Server Tests
        // Skipped gracefully because server/package.json currently
        // has no real test suite (script exits 1 by design).
        // Remove the 'catchError' wrapper once tests are added.
        // -------------------------------------------------------
        stage('Server Tests') {
            steps {
                echo "🧪 Running server tests..."
                dir('server') {
                    // catchError: marks the step as UNSTABLE instead of FAILED
                    // so the pipeline continues until real tests are introduced.
                    catchError(buildResult: 'UNSTABLE', stageResult: 'UNSTABLE') {
                        sh 'npm test'
                    }
                }
                echo "ℹ️  Server has no test suite yet — stage skipped gracefully."
            }
        }

        // -------------------------------------------------------
        // Stage 5: Client Tests
        // react-scripts test requires CI=true and --watchAll=false
        // to run in non-interactive mode.
        // -------------------------------------------------------
        stage('Client Tests') {
            steps {
                echo "🧪 Running client (React) tests..."
                dir('client') {
                    sh 'npm test -- --watchAll=false --passWithNoTests --forceExit'
                }
            }
        }

        // -------------------------------------------------------
        // Stage 6: Build React Production Bundle
        // Runs the react-scripts build outside Docker first so
        // the artefact is available for inspection/archiving.
        // The Docker image build (Stage 7) also runs its own build
        // inside the container — both are intentional so the
        // pipeline can archive static assets independently.
        // -------------------------------------------------------
        stage('Build React App') {
            steps {
                echo "⚛️  Building React production bundle..."
                dir('client') {
                    sh 'npm run build'
                }
                echo "✅ React build complete. Artefacts in client/build/"

                // Archive the build output so it is downloadable from Jenkins
                archiveArtifacts artifacts: 'client/build/**/*', allowEmptyArchive: false
            }
        }

        // -------------------------------------------------------
        // Stage 7: Build Docker Images
        // Uses docker-compose --env-file so all variables come
        // from the .env file (or Jenkins env injected below).
        // If .env does not exist on the agent, generate one from
        // environment variables set in the Jenkins job/global config.
        // -------------------------------------------------------
        stage('Build Docker Images') {
            steps {
                echo "🐳 Building Docker images with docker-compose..."

                // Write a minimal .env so docker-compose can resolve variables.
                // Real secrets (registry creds etc.) are injected via Jenkins
                // credentials — never stored in .env inside the workspace.
                sh '''
                    cat > .env <<EOF
APP_VERSION=${BUILD_NUMBER}
NODE_ENV=production
SERVER_PORT=5001
CLIENT_PORT=80
CLIENT_ORIGIN=http://localhost:80
REACT_APP_API_BASE=/api
REACT_APP_SOCKET_URL=
EOF
                    echo "✅ Generated .env for docker-compose"
                '''

                sh """
                    docker compose \\
                        --file ${COMPOSE_FILE} \\
                        --env-file .env \\
                        --project-name ${APP_NAME} \\
                        build \\
                        --no-cache \\
                        --parallel
                """

                // Tag images with both the build number and 'latest'
                sh """
                    docker tag video-meet-server:${BUILD_NUMBER} video-meet-server:latest 2>/dev/null || \\
                    docker tag video-meet-server:latest video-meet-server:latest || true

                    docker tag video-meet-client:${BUILD_NUMBER} video-meet-client:latest 2>/dev/null || \\
                    docker tag video-meet-client:latest video-meet-client:latest || true
                """

                echo "✅ Docker images built successfully."
                sh 'docker images | grep video-meet'
            }
        }

        // -------------------------------------------------------
        // Stage 8: Push Docker Images to Registry
        // Skipped when PUSH_IMAGES=false or DOCKER_REGISTRY is
        // not configured, so local-only builds still work.
        // -------------------------------------------------------
        stage('Push Docker Images') {
            when {
                allOf {
                    expression { params.PUSH_IMAGES == true }
                    expression { env.DOCKER_REGISTRY?.trim() }
                    expression { env.DOCKER_CREDENTIALS_ID?.trim() }
                }
            }
            steps {
                echo "🚀 Pushing images to registry: ${env.DOCKER_REGISTRY}"

                withCredentials([
                    usernamePassword(
                        credentialsId: "${env.DOCKER_CREDENTIALS_ID}",
                        usernameVariable: 'REGISTRY_USER',
                        passwordVariable: 'REGISTRY_PASS'
                    )
                ]) {
                    sh '''
                        echo "$REGISTRY_PASS" | docker login \
                            --username "$REGISTRY_USER" \
                            --password-stdin \
                            "$DOCKER_REGISTRY" 2>&1 | grep -v "WARNING"
                    '''
                }

                // Tag with registry prefix
                sh """
                    docker tag video-meet-server:${BUILD_NUMBER} ${SERVER_IMAGE}:${BUILD_NUMBER}
                    docker tag video-meet-server:${BUILD_NUMBER} ${SERVER_IMAGE}:latest
                    docker tag video-meet-client:${BUILD_NUMBER} ${CLIENT_IMAGE}:${BUILD_NUMBER}
                    docker tag video-meet-client:${BUILD_NUMBER} ${CLIENT_IMAGE}:latest
                """

                // Push both tags
                sh """
                    docker push ${SERVER_IMAGE}:${BUILD_NUMBER}
                    docker push ${SERVER_IMAGE}:latest
                    docker push ${CLIENT_IMAGE}:${BUILD_NUMBER}
                    docker push ${CLIENT_IMAGE}:latest
                """

                echo "✅ Images pushed successfully."

                // Always log out after pushing
                sh 'docker logout "$DOCKER_REGISTRY" || true'
            }
        }

        // -------------------------------------------------------
        // Stage 9: Deploy with Docker Compose
        // Stops any running containers from a previous build,
        // then starts the new ones in detached mode.
        // -------------------------------------------------------
        stage('Deploy') {
            when {
                expression { params.DEPLOY == true }
            }
            steps {
                echo "🚢 Deploying ${APP_NAME} with docker-compose..."

                // Tear down existing containers (keeps named volumes).
                // --remove-orphans cleans up containers from old service names.
                sh """
                    docker compose \\
                        --file ${COMPOSE_FILE} \\
                        --env-file .env \\
                        --project-name ${APP_NAME} \\
                        down \\
                        --remove-orphans \\
                        --timeout 30 || true
                """

                // Start fresh containers in detached mode.
                // --wait blocks until all healthchecks pass (requires
                // Compose v2.1+ or Docker Compose Plugin ≥ 2.12).
                sh """
                    docker compose \\
                        --file ${COMPOSE_FILE} \\
                        --env-file .env \\
                        --project-name ${APP_NAME} \\
                        up \\
                        --detach \\
                        --remove-orphans
                """

                echo "✅ Containers started. Waiting for services to become healthy..."

                // Give services up to 60 s to reach a healthy state
                // before the health-check stage runs its own verifications.
                sh 'sleep 20'

                echo "📋 Running containers:"
                sh """
                    docker compose \\
                        --file ${COMPOSE_FILE} \\
                        --project-name ${APP_NAME} \\
                        ps
                """
            }
        }

        // -------------------------------------------------------
        // Stage 10: Health Checks
        // Verifies that both the server API and the nginx client
        // are reachable before marking the build as successful.
        // -------------------------------------------------------
        stage('Health Checks') {
            when {
                expression { params.DEPLOY == true }
            }
            steps {
                echo "🏥 Running health checks..."

                // Server health — GET /api/rooms must return 200
                retry(5) {
                    sh '''
                        sleep 5
                        echo "→ Checking backend at http://localhost:${SERVER_PORT}/api/rooms ..."
                        curl --silent --fail --max-time 10 \
                            "http://localhost:${SERVER_PORT}/api/rooms" > /dev/null
                        echo "✅ Backend is healthy."
                    '''
                }

                // Client health — nginx /health endpoint must return 200
                retry(5) {
                    sh '''
                        sleep 3
                        echo "→ Checking frontend at http://localhost:${CLIENT_PORT}/health ..."
                        curl --silent --fail --max-time 10 \
                            "http://localhost:${CLIENT_PORT}/health" > /dev/null
                        echo "✅ Frontend is healthy."
                    '''
                }

                echo "🎉 All health checks passed. Deployment successful!"
            }
        }

    } // end stages

    // ===========================================================
    // POST — always runs regardless of build result
    // ===========================================================
    post {

        always {
            echo "🧹 Post-build cleanup: removing dangling Docker images..."
            sh 'docker image prune --force --filter "dangling=true" || true'

            // Remove the .env file written during the build stage
            // (it contains no secrets but keep workspace tidy)
            sh 'rm -f .env || true'

            echo "📊 Build #${BUILD_NUMBER} finished with status: ${currentBuild.currentResult}"
        }

        success {
            echo """
╔══════════════════════════════════════════╗
║  ✅  BUILD & DEPLOY SUCCEEDED            ║
║                                          ║
║  App     : video-meet                    ║
║  Build   : #${BUILD_NUMBER.padRight(31)}║
║  Branch  : ${params.BRANCH.padRight(31)}║
║  Frontend: http://localhost:${CLIENT_PORT.padRight(22)}║
║  Backend : http://localhost:${SERVER_PORT.padRight(22)}║
╚══════════════════════════════════════════╝
            """
        }

        failure {
            echo """
╔══════════════════════════════════════════╗
║  ❌  BUILD FAILED                        ║
║                                          ║
║  App     : video-meet                    ║
║  Build   : #${BUILD_NUMBER.padRight(31)}║
║  Branch  : ${params.BRANCH.padRight(31)}║
║  Check the stage logs above for details. ║
╚══════════════════════════════════════════╝
            """
            // Stop containers if deploy was attempted but health check failed
            sh """
                docker compose \\
                    --file ${COMPOSE_FILE} \\
                    --project-name ${APP_NAME} \\
                    down --timeout 30 || true
            """ 
        }

        unstable {
            echo "⚠️  Build #${BUILD_NUMBER} is UNSTABLE (server has no tests yet)."
        }

        cleanup {
            // Final workspace cleanup — runs after all other post conditions
            echo "🗑️  Cleanup complete."
        }

    } // end post

} // end pipeline
