import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import './VideoCall.css';
// CHANGE 1: Import SOCKET_URL from config.js instead of hardcoding 'http://localhost:5001'.
// This makes the socket connection work in both development and production environments
// without any code change — config.js already selects the right URL based on hostname.
import { SOCKET_URL } from '../config';

function VideoCall() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  
  // State management
  const [participants, setParticipants] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState(new Map());
  const [localStream, setLocalStream] = useState(null);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [roomInfo, setRoomInfo] = useState(null);
  const [error, setError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('Connecting...');
  const [isAdmin, setIsAdmin] = useState(false);
  const [participantCount, setParticipantCount] = useState(0);
  
  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  // CHANGE 3: Removed unused 'recordingType' state — the type is passed as a parameter to
  // startRecording() and read from the recording object; a top-level state variable was never read.
  // CHANGE 3 (cont.): Removed unused 'recordedChunks' state — chunks are accumulated inside a
  // local array inside startRecording() and never read from this state variable.
  const [recordings, setRecordings] = useState([]);
  const [showRecordings, setShowRecordings] = useState(false);
  
  // UI State
  const [showChat, setShowChat] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [showWhiteboard, setShowWhiteboard] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [hasRaisedHand, setHasRaisedHand] = useState(false);
  
  // Chat and interactions
  const [chatMessages, setChatMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [reactions, setReactions] = useState([]);
  const [raisedHands, setRaisedHands] = useState([]);
  const [roomStats, setRoomStats] = useState(null);
  
  // Refs
  const localVideoRef = useRef();
  const socketRef = useRef();
  const peersRef = useRef(new Map());
  const localStreamRef = useRef();
  const screenStreamRef = useRef();
  const mediaRecorderRef = useRef();
  const recordingStreamRef = useRef();

  useEffect(() => {
    // Prevent automatic start - only initialize if we have proper state
    if (!location.state || !location.state.participantName) {
      // CHANGE 6: Removed verbose emoji console.log — kept only actionable error logging.
      // A simple redirect is self-explanatory; the log added noise without value in production.
      navigate('/');
      return;
    }

    // Check if this is a valid join attempt (not just page refresh)
    const { participantName, participantEmail, passcode } = location.state;
    if (!participantName || !participantEmail || !passcode) {
      navigate('/');
      return;
    }

    // CHANGE 6 (cont.): Removed 'Valid join attempt detected' log — not needed in production.
    initializeCall();

    return () => {
      cleanup();
    };
  }, []);

  const initializeCall = async () => {
    try {
      // CHANGE 6: Removed '🚀 Initializing video call...' log — startup flow is tracked
      // by connection-status state which is displayed in the UI.

      // Clean up any existing socket connection first
      if (socketRef.current) {
        // CHANGE 6: Removed 'Cleaning up existing socket' log.
        socketRef.current.disconnect();
        socketRef.current = null;
      }

      // CHANGE 1 (applied): Connect using SOCKET_URL from config.js instead of the
      // hardcoded 'http://localhost:5001'. In production the config resolves to the
      // deployed server URL automatically.
      socketRef.current = io(SOCKET_URL, {
        forceNew: true, // Force new connection
        transports: ['websocket', 'polling']
      });

      // Get user media first
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: true
        });
      } catch (mediaError) {
        // CHANGE 4: Map specific getUserMedia error names to human-readable messages
        // instead of showing the generic "Please check permissions" fallback for every case.
        // NotAllowedError  — user explicitly denied the permission prompt.
        // NotFoundError    — no camera or microphone device found on the system.
        // NotReadableError — device exists but is already in use by another application.
        let userMessage;
        if (mediaError.name === 'NotAllowedError' || mediaError.name === 'PermissionDeniedError') {
          userMessage = 'Camera and microphone access was denied. Please allow permissions in your browser settings and try again.';
        } else if (mediaError.name === 'NotFoundError' || mediaError.name === 'DevicesNotFoundError') {
          userMessage = 'No camera or microphone found. Please connect a device and try again.';
        } else if (mediaError.name === 'NotReadableError' || mediaError.name === 'TrackStartError') {
          userMessage = 'Camera or microphone is already in use by another application. Please close it and try again.';
        } else if (mediaError.name === 'OverconstrainedError') {
          userMessage = 'Camera does not support the requested resolution. Please try a different camera.';
        } else {
          userMessage = `Unable to access camera/microphone: ${mediaError.message}`;
        }
        setError(userMessage);
        setConnectionStatus('Failed');
        return; // Stop initialisation — do not proceed without a media stream
      }

      // CHANGE 6: Removed '📹 Local stream obtained' log.
      setLocalStream(stream);
      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      setupSocketListeners();

      // Join room after getting media
      const { participantName, participantEmail, passcode, isHost } = location.state;
      // CHANGE 6: Removed '🏠 Joining room ...' log.

      // CHANGE 2: Use optional chaining on socketRef.current before emitting.
      // If the socket disconnected between initialisation and this point the emit
      // is silently skipped instead of throwing "Cannot read properties of null".
      socketRef.current?.emit('join-room', {
        roomId,
        passcode,
        participantName,
        participantEmail,
        isHost: isHost || false
      });

      setConnectionStatus('Connected');

    } catch (error) {
      console.error('Error initializing call:', error);
      setError('Unable to start the call. Please refresh and try again.');
      setConnectionStatus('Failed');
    }
  };

  const setupSocketListeners = () => {
    const socket = socketRef.current;

    socket.on('room-joined', ({ room, isAdmin: adminStatus }) => {
      // CHANGE 6: Removed verbose room/participant/admin console.log lines.
      // The UI already reflects this state via roomInfo, isAdmin, and participantCount.
      setRoomInfo(room);
      setIsAdmin(adminStatus);

      // CRITICAL: Clear any existing state first
      setParticipants([]);
      setRemoteStreams(new Map());
      peersRef.current.clear();

      // Set ONLY the existing participants (excluding self)
      const existingParticipants = room.participants || [];
      setParticipants(existingParticipants);
      setParticipantCount(existingParticipants.length + 1); // +1 for self

      setChatMessages(room.chatMessages || []);
      setRaisedHands(room.raisedHands || []);

      // Create peer connections ONLY for existing participants
      existingParticipants.forEach(participant => {
        createPeerConnection(participant.id, participant, true);
      });
    });

    socket.on('user-joined', (participant) => {
      // CHANGE 6: Removed '👋 New user joined' and participant-count logs.
      // Prevent duplicate participants
      setParticipants(prev => {
        const exists = prev.find(p => p.id === participant.id);
        if (exists) return prev;
        const newList = [...prev, participant];
        setParticipantCount(newList.length + 1); // +1 for self
        return newList;
      });

      // Create peer connection for new participant (they will initiate)
      if (!peersRef.current.has(participant.id)) {
        createPeerConnection(participant.id, participant, false);
      }
    });

    socket.on('participant-count-updated', ({ count }) => {
      // CHANGE 6: Removed server count log and mismatch warning — count mismatches
      // are transient during rapid joins and spam the console without actionable info.
      setParticipantCount(count);
    });

    socket.on('user-left', (userId) => {
      // CHANGE 6: Removed stream-removal and peer-close logs.
      setParticipants(prev => {
        const filtered = prev.filter(p => p.id !== userId);
        setParticipantCount(filtered.length + 1); // +1 for self
        return filtered;
      });

      // Clean up peer connection
      const peer = peersRef.current.get(userId);
      if (peer) {
        peer.close();
        peersRef.current.delete(userId);
      }

      // Remove remote stream
      setRemoteStreams(prev => {
        const newStreams = new Map(prev);
        newStreams.delete(userId);
        return newStreams;
      });
    });

    // Admin-specific event handlers
    socket.on('force-disconnect', ({ reason, message }) => {
      // CHANGE 6: Removed force-disconnect console.log.
      alert(message);
      cleanup();
      navigate('/');
    });

    socket.on('meeting-ended', ({ reason, message, endedBy }) => {
      // CHANGE 6: Removed meeting-ended console.log.
      alert(`${message}${endedBy ? ` by ${endedBy}` : ''}`);
      cleanup();
      navigate('/');
    });

    socket.on('participant-removed', ({ participantId, participantName, removedBy }) => {
      // CHANGE 6: Removed verbose participant-removal logs and the no-op setTimeout log.
      // Immediately remove from participants list
      setParticipants(prev => {
        const filtered = prev.filter(p => p.id !== participantId);
        setParticipantCount(filtered.length + 1); // +1 for self
        return filtered;
      });

      // Clean up peer connection immediately
      const peer = peersRef.current.get(participantId);
      if (peer) {
        peer.close();
        peersRef.current.delete(participantId);
      }

      // Remove remote stream immediately
      setRemoteStreams(prev => {
        const newStreams = new Map(prev);
        newStreams.delete(participantId);
        return newStreams;
      });
    });

    // WebRTC signaling handlers
    socket.on('offer', async ({ offer, senderId }) => {
      // CHANGE 6: Removed 'Received offer' log.
      await handleOffer(offer, senderId);
    });

    socket.on('answer', async ({ answer, senderId }) => {
      // CHANGE 6: Removed 'Received answer' log.
      await handleAnswer(answer, senderId);
    });

    socket.on('ice-candidate', async ({ candidate, senderId }) => {
      // CHANGE 6: Removed 'Received ICE candidate' log.
      await handleIceCandidate(candidate, senderId);
    });

    // Chat and interaction handlers
    socket.on('new-chat-message', (message) => {
      setChatMessages(prev => [...prev, message]);
    });

    socket.on('new-reaction', (reaction) => {
      setReactions(prev => [...prev, reaction]);
      // Remove reaction after 3 seconds
      setTimeout(() => {
        setReactions(prev => prev.filter(r => r.id !== reaction.id));
      }, 3000);
    });

    socket.on('participant-hand-toggle', ({ participantId, isRaised, participantName }) => {
      if (isRaised) {
        setRaisedHands(prev => [...prev, { participantId, participantName }]);
      } else {
        setRaisedHands(prev => prev.filter(h => h.participantId !== participantId));
      }
    });

    socket.on('participant-video-toggle', ({ participantId, isEnabled }) => {
      setParticipants(prev => prev.map(p => 
        p.id === participantId ? { ...p, isVideoEnabled: isEnabled } : p
      ));
    });

    socket.on('participant-audio-toggle', ({ participantId, isEnabled }) => {
      setParticipants(prev => prev.map(p => 
        p.id === participantId ? { ...p, isAudioEnabled: isEnabled } : p
      ));
    });

    socket.on('room-stats', (stats) => {
      setRoomStats(stats);
    });

    socket.on('error', (message) => {
      console.error('Socket error:', message);
      setError(message);
      setConnectionStatus('Error');
    });

    socket.on('connect', () => {
      // CHANGE 6: Removed 'Socket connected' log — status is shown in the UI.
      setConnectionStatus('Connected');
    });

    socket.on('disconnect', () => {
      // CHANGE 6: Removed 'Socket disconnected' log — status is shown in the UI.
      setConnectionStatus('Disconnected');
    });
  };

  const createPeerConnection = (peerId, participant, shouldCreateOffer) => {
    // CHANGE 6: Removed verbose peer-creation log.

    // Check if peer connection already exists
    if (peersRef.current.has(peerId)) {
      return;
    }

    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    });

    // Add local stream tracks
    const currentStream = isScreenSharing ? screenStreamRef.current : localStreamRef.current;
    if (currentStream) {
      currentStream.getTracks().forEach(track => {
        peer.addTrack(track, currentStream);
        // CHANGE 6: Removed per-track 'Added track' log.
      });
    }

    // Handle remote stream
    peer.ontrack = (event) => {
      // CHANGE 6: Removed 'Received remote stream' log.
      const [remoteStream] = event.streams;
      setRemoteStreams(prev => {
        const newStreams = new Map(prev);
        newStreams.set(peerId, remoteStream);
        // CHANGE 6: Removed 'Stored remote stream' log.
        return newStreams;
      });
    };

    // Handle ICE candidates
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        // CHANGE 2: Optional chaining — skip the emit silently if socket is null/disconnected.
        // This prevents an uncaught TypeError during cleanup or network interruption.
        socketRef.current?.emit('ice-candidate', {
          candidate: event.candidate,
          targetId: peerId
        });
      }
    };

    // Connection state monitoring
    peer.onconnectionstatechange = () => {
      // CHANGE 6: Removed connection-state-change log — kept only failure handling.
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        // Clean up failed connection
        setTimeout(() => {
          if (peersRef.current.has(peerId)) {
            peersRef.current.delete(peerId);
            setRemoteStreams(prev => {
              const newStreams = new Map(prev);
              newStreams.delete(peerId);
              return newStreams;
            });
          }
        }, 5000);
      }
    };

    // CHANGE 6: Removed ICE connection state log.
    peer.oniceconnectionstatechange = () => {};

    // Store peer connection
    peersRef.current.set(peerId, peer);

    // Create offer if we should initiate
    if (shouldCreateOffer) {
      createOffer(peerId);
    }
  };

  const createOffer = async (peerId) => {
    try {
      const peer = peersRef.current.get(peerId);
      if (!peer) return;

      // CHANGE 6: Removed 'Creating offer' log.
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      // CHANGE 2: Optional chaining — safe emit even if socket disconnected mid-negotiation.
      socketRef.current?.emit('offer', {
        offer: offer,
        targetId: peerId
      });
      // CHANGE 6: Removed 'Offer sent' log.
    } catch (error) {
      console.error(`Error creating offer for ${peerId}:`, error);
    }
  };

  const handleOffer = async (offer, senderId) => {
    try {
      let peer = peersRef.current.get(senderId);

      // Create peer connection if it doesn't exist
      if (!peer) {
        // CHANGE 6: Removed 'Creating peer connection for incoming offer' log.
        const participant = participants.find(p => p.id === senderId) || { id: senderId, name: 'Unknown' };
        createPeerConnection(senderId, participant, false);
        peer = peersRef.current.get(senderId);
      }

      if (!peer) {
        console.error(`No peer connection found for ${senderId}`);
        return;
      }

      // CHANGE 6: Removed 'Processing offer' log.
      await peer.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      // CHANGE 2: Optional chaining — safe emit if socket is null at this point.
      socketRef.current?.emit('answer', {
        answer: answer,
        targetId: senderId
      });
      // CHANGE 6: Removed 'Answer sent' log.
    } catch (error) {
      console.error(`Error handling offer from ${senderId}:`, error);
    }
  };

  const handleAnswer = async (answer, senderId) => {
    try {
      const peer = peersRef.current.get(senderId);
      if (!peer) {
        console.error(`No peer connection found for ${senderId}`);
        return;
      }

      // CHANGE 6: Removed 'Processing answer' and 'Answer processed' logs.
      await peer.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
      console.error(`Error handling answer from ${senderId}:`, error);
    }
  };

  const handleIceCandidate = async (candidate, senderId) => {
    try {
      const peer = peersRef.current.get(senderId);
      if (!peer) {
        console.error(`No peer connection found for ${senderId}`);
        return;
      }

      await peer.addIceCandidate(new RTCIceCandidate(candidate));
      // CHANGE 6: Removed 'ICE candidate added' log.
    } catch (error) {
      console.error(`Error adding ICE candidate from ${senderId}:`, error);
    }
  };

  // Media control functions
  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
        // CHANGE 2: Optional chaining — prevents crash if socket is null when toggling.
        socketRef.current?.emit('toggle-video', { isEnabled: videoTrack.enabled });
        // CHANGE 6: Removed toggle-video log.
      }
    }
  }, []);

  const toggleAudio = useCallback(() => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
        // CHANGE 2: Optional chaining — prevents crash if socket is null when toggling.
        socketRef.current?.emit('toggle-audio', { isEnabled: audioTrack.enabled });
        // CHANGE 6: Removed toggle-audio log.
      }
    }
  }, []);

  const toggleScreenShare = useCallback(async () => {
    try {
      if (!isScreenSharing) {
        // Start screen sharing
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });
        
        screenStreamRef.current = screenStream;
        setIsScreenSharing(true);
        
        // Replace video track in all peer connections
        peersRef.current.forEach(async (peer, peerId) => {
          const sender = peer.getSenders().find(s => 
            s.track && s.track.kind === 'video'
          );
          if (sender) {
            await sender.replaceTrack(screenStream.getVideoTracks()[0]);
          }
        });
        
        // Update local video
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = screenStream;
        }
        
        // Handle screen share end
        screenStream.getVideoTracks()[0].onended = () => {
          stopScreenShare();
        };
        
      } else {
        stopScreenShare();
      }
    } catch (error) {
      console.error('❌ Error toggling screen share:', error);
    }
  }, [isScreenSharing]);

  const stopScreenShare = useCallback(async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
    }
    
    setIsScreenSharing(false);
    
    // Replace back to camera stream
    peersRef.current.forEach(async (peer, peerId) => {
      const sender = peer.getSenders().find(s => 
        s.track && s.track.kind === 'video'
      );
      if (sender && localStreamRef.current) {
        await sender.replaceTrack(localStreamRef.current.getVideoTracks()[0]);
      }
    });
    
    // Update local video back to camera
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, []);

  const toggleRaiseHand = useCallback(() => {
    const newState = !hasRaisedHand;
    setHasRaisedHand(newState);
    // CHANGE 2: Optional chaining — prevents crash if socket disconnects while user raises hand.
    socketRef.current?.emit('toggle-raise-hand', { isRaised: newState });
  }, [hasRaisedHand]);

  const sendReaction = useCallback((reaction) => {
    // CHANGE 2: Optional chaining — prevents crash if socket is null when sending reaction.
    socketRef.current?.emit('send-reaction', { reaction });
  }, []);

  const sendChatMessage = useCallback(() => {
    if (newMessage.trim()) {
      // CHANGE 2: Optional chaining — prevents crash if socket disconnects during message send.
      socketRef.current?.emit('send-chat-message', { message: newMessage.trim() });
      setNewMessage('');
    }
  }, [newMessage]);

  const refreshConnection = useCallback(() => {
    // CHANGE 7: Check that the socket is connected before attempting to refresh peer
    // connections. If the socket is not available the server cannot relay new offers,
    // so refreshing would produce silent failures.
    if (!socketRef.current || !socketRef.current.connected) {
      setConnectionStatus('Disconnected — cannot refresh');
      return;
    }

    setConnectionStatus('Refreshing...');
    // CHANGE 6: Removed verbose refresh-start and per-peer logs.

    // Close all peer connections
    peersRef.current.forEach((peer) => {
      peer.close();
    });
    peersRef.current.clear();
    setRemoteStreams(new Map());

    // Reconnect after a short delay
    setTimeout(() => {
      // CHANGE 6: Removed 'Recreating peer connections' log.
      participants.forEach(participant => {
        createPeerConnection(participant.id, participant, true);
      });
      setConnectionStatus('Connected');
    }, 1000);
  }, [participants]);

  const getStats = useCallback(() => {
    // CHANGE 2: Optional chaining — prevents crash if socket is null when fetching stats.
    socketRef.current?.emit('get-room-stats');
    setShowStats(true);
  }, []);

  // Recording functions
  const startRecording = useCallback(async (type = 'both') => {
    try {
      // CHANGE 6: Removed '🎥 Starting recording' log.
      const currentStream = isScreenSharing ? screenStreamRef.current : localStreamRef.current;

      // Determine the stream to record based on type
      let stream;
      if (type === 'video' || type === 'both') {
        stream = currentStream;
      } else if (type === 'audio') {
        // Record audio only — build a stream containing just the audio track
        stream = new MediaStream();
        const audioTrack = currentStream.getAudioTracks()[0];
        if (audioTrack) {
          stream.addTrack(audioTrack);
        }
      }

      if (!stream) {
        throw new Error('No stream available for recording');
      }

      recordingStreamRef.current = stream;
      // CHANGE 3: Removed setRecordingType() call — the removed state variable was only
      // written here and never read anywhere else in the component.

      // Create MediaRecorder with a codec fallback chain for cross-browser support
      const options = { mimeType: 'video/webm;codecs=vp9,opus' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'video/webm;codecs=vp8,opus';
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options.mimeType = 'video/webm';
          if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = '';
          }
        }
      }

      mediaRecorderRef.current = new MediaRecorder(stream, options);
      const chunks = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
        // CHANGE 6: Removed 'Recording stopped, processing' log.
        const blob = new Blob(chunks, {
          type: type === 'audio' ? 'audio/webm' : 'video/webm'
        });

        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toLocaleString();
        const filename = `${type}_recording_${Date.now()}.webm`;

        const newRecording = {
          id: Date.now(),
          type,
          url,
          blob,
          filename,
          timestamp,
          duration: 0 // Calculated when played back
        };

        setRecordings(prev => [...prev, newRecording]);
        // CHANGE 6: Removed 'Recording saved' log.
        chunks.length = 0;
      };

      mediaRecorderRef.current.start(1000); // Collect data every second
      setIsRecording(true);
      // CHANGE 3: Removed setRecordedChunks([]) — state variable was removed in Change 3
      // because chunks are accumulated in a local array inside this closure, not in state.
      // CHANGE 6: Removed '✅ recording started' log.

    } catch (error) {
      console.error('Error starting recording:', error);
      alert('Failed to start recording. Please check your browser permissions.');
    }
  }, [isScreenSharing]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      // CHANGE 6: Removed 'Stopping recording' and 'Recording stopped' logs.
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  const downloadRecording = useCallback((recording) => {
    const link = document.createElement('a');
    link.href = recording.url;
    link.download = recording.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // CHANGE 6: Removed 'Downloaded' log.
  }, []);

  const deleteRecording = useCallback((recordingId) => {
    setRecordings(prev => {
      const recording = prev.find(r => r.id === recordingId);
      if (recording) {
        URL.revokeObjectURL(recording.url);
        // CHANGE 6: Removed 'Deleted recording' log.
      }
      return prev.filter(r => r.id !== recordingId);
    });
  }, []);

  const leaveCall = useCallback(() => {
    // CHANGE 6: Removed 'Leaving call' log.
    cleanup();
    navigate('/');
  }, [navigate]);

  // Admin-only functions
  const removeParticipant = useCallback((participantId) => {
    if (!isAdmin) {
      // CHANGE 6: Removed admin-guard log — the alert shown to the user is sufficient feedback.
      alert('Only the host can remove participants');
      return;
    }

    const participant = participants.find(p => p.id === participantId);
    if (!participant) {
      // CHANGE 6: Removed 'Participant not found' log — no user-visible action is needed here.
      return;
    }

    if (window.confirm(`Remove ${participant.name} from the meeting?\n\nThey will be immediately disconnected and cannot rejoin unless invited again.`)) {
      // CHANGE 2: Optional chaining — prevents crash if socket is null when admin removes a participant.
      // CHANGE 6: Removed 'Admin removing participant' log.
      socketRef.current?.emit('admin-remove-participant', { participantId });

      // Optimistically update UI (confirmed by server 'participant-removed' event)
      setParticipants(prev => prev.filter(p => p.id !== participantId));
    }
  }, [isAdmin, participants]);

  const endMeeting = useCallback(() => {
    if (!isAdmin) {
      // CHANGE 6: Removed admin-guard log.
      alert('Only the host can end the meeting');
      return;
    }

    const participantCount = participants.length;
    const confirmMessage = participantCount > 0
      ? `End the meeting for all ${participantCount + 1} participants?\n\nEveryone will be disconnected immediately.`
      : 'End the meeting?\n\nThe room will be closed.';

    if (window.confirm(confirmMessage)) {
      // CHANGE 2: Optional chaining — prevents crash if socket is null when admin ends meeting.
      // CHANGE 6: Removed 'Admin ending meeting' log.
      socketRef.current?.emit('admin-end-meeting');

      setConnectionStatus('Ending meeting...');

      // Clean up and navigate after a brief delay to let the server broadcast first
      setTimeout(() => {
        cleanup();
        navigate('/');
      }, 2000);
    }
  }, [isAdmin, participants.length, navigate]);

  const cleanup = () => {
    // CHANGE 6: Removed '🧹 Cleaning up' log.

    // Stop recording if active
    if (isRecording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }

    // Stop all local media tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.stop();
        // CHANGE 6: Removed per-track stop log.
      });
    }

    // Stop screen share stream if active
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
    }

    // Close all WebRTC peer connections
    peersRef.current.forEach((peer) => {
      peer.close();
      // CHANGE 6: Removed per-peer close log.
    });
    peersRef.current.clear();

    // Disconnect socket and release the reference
    if (socketRef.current) {
      socketRef.current.disconnect();
      // CHANGE 5: Null out the ref after disconnect so any pending optional-chained emits
      // (socketRef.current?.emit) safely short-circuit instead of emitting on a dead socket.
      socketRef.current = null;
      // CHANGE 6: Removed 'Socket disconnected' log.
    }
  };

  if (error) {
    return (
      <div className="video-call-container">
        <div className="error-screen">
          <h2>Connection Error</h2>
          <p>{error}</p>
          <button onClick={() => navigate('/')} className="btn btn-primary">
            Return Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="video-call-container">
      {/* Header */}
      <div className="video-call-header">
        <div className="room-info">
          <h2>Room: {roomId} {isAdmin && <span className="admin-crown">👑</span>}</h2>
          {roomInfo && <p>Host: {roomInfo.creatorName}</p>}
          <p>Participants: {participantCount}</p>
        </div>
        <div className="connection-status">
          <span className={`status-indicator ${connectionStatus.toLowerCase()}`}>
            {connectionStatus}
          </span>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="main-content">
        {/* Video Grid */}
        <div className={`video-grid ${showChat || showPeople ? 'with-sidebar' : ''}`}>
          {/* Local video */}
          <div className="video-wrapper local-video">
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className={`video ${!isVideoEnabled ? 'video-disabled' : ''}`}
            />
            <div className="video-label">
              You{isAdmin && ' (Host) 👑'} {!isVideoEnabled && '(Video Off)'}
              {isScreenSharing && ' (Screen Sharing)'}
              {hasRaisedHand && ' ✋'}
            </div>
            <div className="video-controls-overlay">
              <button
                onClick={toggleVideo}
                className={`mini-control-btn ${!isVideoEnabled ? 'disabled' : ''}`}
                title={isVideoEnabled ? 'Turn off video' : 'Turn on video'}
              >
                {isVideoEnabled ? '📹' : '📹❌'}
              </button>
              <button
                onClick={toggleAudio}
                className={`mini-control-btn ${!isAudioEnabled ? 'disabled' : ''}`}
                title={isAudioEnabled ? 'Mute audio' : 'Unmute audio'}
              >
                {isAudioEnabled ? '🎤' : '🎤❌'}
              </button>
            </div>
          </div>

          {/* Remote videos — only render participants with fully resolved data */}
          {participants
            .filter(participant => participant && participant.id && participant.name)
            .map((participant, index) => {
              const remoteStream = remoteStreams.get(participant.id);
              // CHANGE 6: Removed per-render participant log — this fired on every re-render
              // (e.g. every chat message or state update) producing enormous console noise.
              return (
                <RemoteVideo
                  key={participant.id}
                  participant={participant}
                  stream={remoteStream}
                  index={index}
                  raisedHands={raisedHands}
                />
              );
            })}
        </div>

        {/* Sidebar */}
        {(showChat || showPeople || showRecordings) && (
          <div className="sidebar">
            {showChat && (
              <div className="chat-panel">
                <div className="chat-header">
                  <h3>Chat</h3>
                  <button onClick={() => setShowChat(false)}>✕</button>
                </div>
                <div className="chat-messages">
                  {chatMessages.map(msg => (
                    <div key={msg.id} className="chat-message">
                      <strong>{msg.senderName}:</strong> {msg.message}
                      <span className="timestamp">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="chat-input">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && sendChatMessage()}
                    placeholder="Type a message..."
                  />
                  <button onClick={sendChatMessage}>Send</button>
                </div>
              </div>
            )}

            {showPeople && (
              <div className="people-panel">
                <div className="people-header">
                  <h3>Participants ({participantCount})</h3>
                  <button onClick={() => setShowPeople(false)}>✕</button>
                </div>
                <div className="people-list">
                  <div className="participant-item self-participant">
                    <div className="participant-info">
                      <span className="participant-name">
                        You{isAdmin && ' (Host)'}
                        {isAdmin && <span className="admin-crown">👑</span>}
                      </span>
                      {hasRaisedHand && <span className="raised-hand">✋</span>}
                    </div>
                    <div className="participant-status">
                      {isVideoEnabled ? '📹' : '📹❌'}
                      {isAudioEnabled ? '🎤' : '🎤❌'}
                    </div>
                  </div>
                  
                  {participants.map(participant => (
                    <div key={participant.id} className="participant-item">
                      <div className="participant-info">
                        <span className="participant-name">
                          {participant.name}
                          {participant.isAdmin && ' (Host)'}
                          {participant.isAdmin && <span className="admin-crown">👑</span>}
                        </span>
                        {raisedHands.some(h => h.participantId === participant.id) && 
                          <span className="raised-hand">✋</span>
                        }
                      </div>
                      <div className="participant-controls">
                        <div className="participant-status">
                          {participant.isVideoEnabled ? '📹' : '📹❌'}
                          {participant.isAudioEnabled ? '🎤' : '🎤❌'}
                        </div>
                        {isAdmin && !participant.isAdmin && (
                          <button 
                            className="remove-participant-btn"
                            onClick={() => removeParticipant(participant.id)}
                            title={`Remove ${participant.name} from meeting`}
                          >
                            🚫
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                
                {isAdmin && (
                  <div className="admin-controls">
                    <div className="admin-info">
                      <span className="admin-badge">👑 Host Controls</span>
                    </div>
                    <button 
                      className="end-meeting-btn"
                      onClick={endMeeting}
                      title="End meeting for all participants"
                    >
                      🔚 End Meeting for All
                    </button>
                  </div>
                )}
              </div>
            )}

            {showRecordings && (
              <div className="recordings-panel">
                <div className="recordings-header">
                  <h3>My Recordings ({recordings.length})</h3>
                  <button onClick={() => setShowRecordings(false)}>✕</button>
                </div>
                <div className="recordings-list">
                  {recordings.length === 0 ? (
                    <div className="no-recordings">
                      <p>No recordings yet</p>
                      <p>Use the record button to start recording</p>
                    </div>
                  ) : (
                    recordings.map(recording => (
                      <div key={recording.id} className="recording-item">
                        <div className="recording-info">
                          <div className="recording-type">
                            {recording.type === 'both' && '🎥'}
                            {recording.type === 'video' && '📹'}
                            {recording.type === 'audio' && '🎤'}
                            <span>{recording.type === 'both' ? 'Video + Audio' : 
                                   recording.type === 'video' ? 'Video Only' : 'Audio Only'}</span>
                          </div>
                          <div className="recording-timestamp">{recording.timestamp}</div>
                        </div>
                        <div className="recording-preview">
                          {recording.type !== 'audio' ? (
                            <video 
                              src={recording.url} 
                              controls 
                              width="100%" 
                              height="120"
                              style={{borderRadius: '8px'}}
                            />
                          ) : (
                            <audio 
                              src={recording.url} 
                              controls 
                              style={{width: '100%'}}
                            />
                          )}
                        </div>
                        <div className="recording-actions">
                          <button 
                            onClick={() => downloadRecording(recording)}
                            className="download-btn"
                            title="Download recording"
                          >
                            📥 Download
                          </button>
                          <button 
                            onClick={() => deleteRecording(recording.id)}
                            className="delete-btn"
                            title="Delete recording"
                          >
                            🗑️ Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reactions Overlay */}
      <div className="reactions-overlay">
        {reactions.map(reaction => (
          <div key={reaction.id} className="reaction-bubble">
            {reaction.reaction}
          </div>
        ))}
      </div>

      {/* Stats Modal */}
      {showStats && roomStats && (
        <div className="modal-overlay" onClick={() => setShowStats(false)}>
          <div className="stats-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Room Statistics</h3>
              <button onClick={() => setShowStats(false)}>✕</button>
            </div>
            <div className="stats-content">
              <div className="stat-item">
                <span>Total Participants:</span>
                <span>{roomStats.totalParticipants}</span>
              </div>
              <div className="stat-item">
                <span>Chat Messages:</span>
                <span>{roomStats.chatMessages}</span>
              </div>
              <div className="stat-item">
                <span>Raised Hands:</span>
                <span>{roomStats.raisedHands}</span>
              </div>
              <div className="stat-item">
                <span>Video Enabled:</span>
                <span>{roomStats.videoEnabled}</span>
              </div>
              <div className="stat-item">
                <span>Audio Enabled:</span>
                <span>{roomStats.audioEnabled}</span>
              </div>
              <div className="stat-item">
                <span>Room Duration:</span>
                <span>{Math.floor(roomStats.roomDuration / 60000)} minutes</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Whiteboard Modal */}
      {showWhiteboard && (
        <div className="modal-overlay" onClick={() => setShowWhiteboard(false)}>
          <div className="whiteboard-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Whiteboard</h3>
              <button onClick={() => setShowWhiteboard(false)}>✕</button>
            </div>
            <div className="whiteboard-content">
              <canvas width="800" height="600" style={{border: '1px solid #ccc', background: 'white'}} />
              <p>Whiteboard functionality - Coming soon!</p>
            </div>
          </div>
        </div>
      )}

      {/* Control Bar */}
      <div className="control-bar">
        <div className="control-group">
          <button
            onClick={toggleAudio}
            className={`control-btn audio-btn ${!isAudioEnabled ? 'disabled' : ''}`}
            title={isAudioEnabled ? 'Mute' : 'Unmute'}
          >
            {isAudioEnabled ? '🎤' : '🎤❌'}
            <span>Mute</span>
          </button>
          
          <button
            onClick={toggleVideo}
            className={`control-btn video-btn ${!isVideoEnabled ? 'disabled' : ''}`}
            title={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
          >
            {isVideoEnabled ? '📹' : '📹❌'}
            <span>Camera</span>
          </button>
          
          <button
            onClick={toggleScreenShare}
            className={`control-btn screen-btn ${isScreenSharing ? 'active' : ''}`}
            title="Share Screen"
          >
            🖥️
            <span>Share</span>
          </button>
        </div>

        <div className="control-group">
          <button
            onClick={() => setShowChat(!showChat)}
            className={`control-btn chat-btn ${showChat ? 'active' : ''}`}
            title="Chat"
          >
            💬
            <span>Chat</span>
          </button>
          
          <button
            onClick={() => setShowPeople(!showPeople)}
            className={`control-btn people-btn ${showPeople ? 'active' : ''}`}
            title="Participants"
          >
            👥
            <span>People</span>
          </button>
          
          <button
            onClick={() => setShowWhiteboard(!showWhiteboard)}
            className="control-btn whiteboard-btn"
            title="Whiteboard"
          >
            📝
            <span>Whiteboard</span>
          </button>
          
          <div className="recording-controls">
            <button 
              className={`control-btn recording-btn ${isRecording ? 'recording-active' : ''}`} 
              title="Recording Options"
            >
              {isRecording ? '🔴' : '🎥'}
              <span>{isRecording ? 'Recording' : 'Record'}</span>
            </button>
            <div className="recording-menu">
              {!isRecording ? (
                <>
                  <button onClick={() => startRecording('both')}>
                    🎥 Video + Audio
                  </button>
                  <button onClick={() => startRecording('video')}>
                    📹 Video Only
                  </button>
                  <button onClick={() => startRecording('audio')}>
                    🎤 Audio Only
                  </button>
                </>
              ) : (
                <button onClick={stopRecording} className="stop-recording">
                  ⏹️ Stop Recording
                </button>
              )}
            </div>
          </div>
          
          <button
            onClick={() => setShowRecordings(!showRecordings)}
            className={`control-btn recordings-btn ${showRecordings ? 'active' : ''}`}
            title="My Recordings"
          >
            📁
            <span>Recordings</span>
            {recordings.length > 0 && (
              <span className="recording-count">{recordings.length}</span>
            )}
          </button>
        </div>

        <div className="control-group">
          <div className="reactions-dropdown">
            <button className="control-btn reactions-btn" title="Reactions">
              😊
              <span>Reactions</span>
            </button>
            <div className="reactions-menu">
              {['👍', '👎', '😊', '😂', '😮', '❤️', '👏', '🎉'].map(emoji => (
                <button key={emoji} onClick={() => sendReaction(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          </div>
          
          <button
            onClick={toggleRaiseHand}
            className={`control-btn hand-btn ${hasRaisedHand ? 'active' : ''}`}
            title="Raise Hand"
          >
            ✋
            <span>Raise Hand</span>
          </button>
          
          <button
            onClick={getStats}
            className="control-btn stats-btn"
            title="View Stats"
          >
            📊
            <span>Stats</span>
          </button>
          
          <button
            onClick={refreshConnection}
            className="control-btn refresh-btn"
            title="Refresh Connection"
          >
            🔄
            <span>Refresh</span>
          </button>
        </div>

        <div className="control-group">
          <button 
            onClick={leaveCall} 
            className="control-btn leave-btn"
            title="Leave Meeting"
          >
            📞❌
            <span>Leave</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Separate component for remote video to ensure proper re-rendering
const RemoteVideo = React.memo(({ participant, stream, index, raisedHands }) => {
  const videoRef = useRef();
  const [isStreamActive, setIsStreamActive] = useState(false);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      setIsStreamActive(true);
      // CHANGE 6: Removed 'Remote video set for ...' log — fires on every stream assignment,
      // producing log spam during normal connection churn.
    } else {
      setIsStreamActive(false);
    }
  }, [stream, participant.name]);

  const colorClass = `remote-video-${(index % 6) + 1}`;
  const hasRaisedHand = raisedHands.some(h => h.participantId === participant.id);

  return (
    <div className={`video-wrapper remote-video ${colorClass}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`video ${!participant.isVideoEnabled ? 'video-disabled' : ''}`}
      />
      <div className="video-label">
        {participant.name}
        {participant.isAdmin && ' (Host) 👑'}
        {!participant.isVideoEnabled && ' (Video Off)'}
        {!participant.isAudioEnabled && ' (Muted)'}
        {hasRaisedHand && ' ✋'}
        {!isStreamActive && ' (Connecting...)'}
      </div>
      {!isStreamActive && (
        <div className="loading-overlay">
          <div className="loading-spinner"></div>
          <p>Connecting to {participant.name}...</p>
        </div>
      )}
      <div className="participant-status-overlay">
        {!participant.isVideoEnabled && <span className="status-icon">📹❌</span>}
        {!participant.isAudioEnabled && <span className="status-icon">🎤❌</span>}
      </div>
    </div>
  );
});

export default VideoCall;