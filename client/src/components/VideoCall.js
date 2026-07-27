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
  // localStream state removed — the value was written once but never read in JSX or
  // any other callback.  localStreamRef is the live reference used throughout.
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

  // ─────────────────────────────────────────────────────────────────────────
  // Hooks are declared bottom-up so every function is defined before it is
  // referenced.  This satisfies no-use-before-define without disabling ESLint.
  // ─────────────────────────────────────────────────────────────────────────

  // 1. cleanup ── leaf: only reads isRecording state + refs. No other hooks.
  const cleanup = useCallback(() => {
    if (isRecording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
    }
    peersRef.current.forEach(peer => peer.close());
    peersRef.current.clear();
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  }, [isRecording]);

  // 2. createOffer ── leaf: only reads refs.
  const createOffer = useCallback(async (peerId) => {
    try {
      const peer = peersRef.current.get(peerId);
      if (!peer) return;
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socketRef.current?.emit('offer', { offer, targetId: peerId });
    } catch (err) {
      console.error(`Error creating offer for ${peerId}:`, err);
    }
  }, []);

  // 3. handleOffer ── leaf: only reads refs.
  const handleOffer = useCallback(async (offer, senderId) => {
    try {
      const peer = peersRef.current.get(senderId);
      if (!peer) { console.error(`No peer connection found for ${senderId}`); return; }
      await peer.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socketRef.current?.emit('answer', { answer, targetId: senderId });
    } catch (err) {
      console.error(`Error handling offer from ${senderId}:`, err);
    }
  }, []);

  // 4. handleAnswer ── leaf: only reads refs.
  const handleAnswer = useCallback(async (answer, senderId) => {
    try {
      const peer = peersRef.current.get(senderId);
      if (!peer) { console.error(`No peer connection found for ${senderId}`); return; }
      await peer.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error(`Error handling answer from ${senderId}:`, err);
    }
  }, []);

  // 5. handleIceCandidate ── leaf: only reads refs.
  const handleIceCandidate = useCallback(async (candidate, senderId) => {
    try {
      const peer = peersRef.current.get(senderId);
      if (!peer) { console.error(`No peer connection found for ${senderId}`); return; }
      await peer.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error(`Error adding ICE candidate from ${senderId}:`, err);
    }
  }, []);

  // 6. createPeerConnection ── depends on isScreenSharing state + createOffer.
  const createPeerConnection = useCallback((peerId, _participant, shouldCreateOffer) => {
    if (peersRef.current.has(peerId)) return;

    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
    });

    const currentStream = isScreenSharing ? screenStreamRef.current : localStreamRef.current;
    if (currentStream) {
      currentStream.getTracks().forEach(track => peer.addTrack(track, currentStream));
    }

    peer.ontrack = (event) => {
      const [remoteStream] = event.streams;
      setRemoteStreams(prev => {
        const m = new Map(prev);
        m.set(peerId, remoteStream);
        return m;
      });
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('ice-candidate', {
          candidate: event.candidate,
          targetId: peerId,
        });
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        setTimeout(() => {
          if (peersRef.current.has(peerId)) {
            peersRef.current.delete(peerId);
            setRemoteStreams(prev => {
              const m = new Map(prev);
              m.delete(peerId);
              return m;
            });
          }
        }, 5000);
      }
    };

    peer.oniceconnectionstatechange = () => {};

    peersRef.current.set(peerId, peer);
    if (shouldCreateOffer) createOffer(peerId);
  }, [isScreenSharing, createOffer]);

  // 7. setupSocketListeners ── depends on createPeerConnection, handleOffer,
  //    handleAnswer, handleIceCandidate, cleanup, navigate.
  const setupSocketListeners = useCallback(() => {
    const socket = socketRef.current;

    socket.on('room-joined', ({ room, isAdmin: adminStatus }) => {
      setRoomInfo(room);
      setIsAdmin(adminStatus);
      setParticipants([]);
      setRemoteStreams(new Map());
      peersRef.current.clear();
      const existing = room.participants || [];
      setParticipants(existing);
      setParticipantCount(existing.length + 1);
      setChatMessages(room.chatMessages || []);
      setRaisedHands(room.raisedHands || []);
      existing.forEach(p => createPeerConnection(p.id, p, true));
    });

    socket.on('user-joined', (participant) => {
      setParticipants(prev => {
        if (prev.find(p => p.id === participant.id)) return prev;
        const next = [...prev, participant];
        setParticipantCount(next.length + 1);
        return next;
      });
      if (!peersRef.current.has(participant.id)) {
        createPeerConnection(participant.id, participant, false);
      }
    });

    socket.on('participant-count-updated', ({ count }) => setParticipantCount(count));

    socket.on('user-left', (userId) => {
      setParticipants(prev => {
        const filtered = prev.filter(p => p.id !== userId);
        setParticipantCount(filtered.length + 1);
        return filtered;
      });
      const p = peersRef.current.get(userId);
      if (p) { p.close(); peersRef.current.delete(userId); }
      setRemoteStreams(prev => { const m = new Map(prev); m.delete(userId); return m; });
    });

    socket.on('force-disconnect', ({ message }) => {
      alert(message);
      cleanup();
      navigate('/');
    });

    socket.on('meeting-ended', ({ message, endedBy }) => {
      alert(`${message}${endedBy ? ` by ${endedBy}` : ''}`);
      cleanup();
      navigate('/');
    });

    socket.on('participant-removed', ({ participantId }) => {
      setParticipants(prev => {
        const filtered = prev.filter(p => p.id !== participantId);
        setParticipantCount(filtered.length + 1);
        return filtered;
      });
      const p = peersRef.current.get(participantId);
      if (p) { p.close(); peersRef.current.delete(participantId); }
      setRemoteStreams(prev => { const m = new Map(prev); m.delete(participantId); return m; });
    });

    socket.on('offer', async ({ offer, senderId }) => { await handleOffer(offer, senderId); });
    socket.on('answer', async ({ answer, senderId }) => { await handleAnswer(answer, senderId); });
    socket.on('ice-candidate', async ({ candidate, senderId }) => { await handleIceCandidate(candidate, senderId); });

    socket.on('new-chat-message', msg => setChatMessages(prev => [...prev, msg]));

    socket.on('new-reaction', (reaction) => {
      setReactions(prev => [...prev, reaction]);
      setTimeout(() => setReactions(prev => prev.filter(r => r.id !== reaction.id)), 3000);
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

    socket.on('room-stats', stats => setRoomStats(stats));

    socket.on('error', (message) => {
      console.error('Socket error:', message);
      setError(message);
      setConnectionStatus('Error');
    });

    socket.on('connect', () => setConnectionStatus('Connected'));
    socket.on('disconnect', () => setConnectionStatus('Disconnected'));
  }, [createPeerConnection, handleOffer, handleAnswer, handleIceCandidate, cleanup, navigate]);

  // 8. initializeCall ── depends on setupSocketListeners, roomId, location.state.
  const initializeCall = useCallback(async () => {
    try {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }

      socketRef.current = io(SOCKET_URL, { forceNew: true, transports: ['websocket', 'polling'] });

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: true,
        });
      } catch (mediaError) {
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
        return;
      }

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      setupSocketListeners();

      const { participantName, participantEmail, passcode, isHost } = location.state;
      socketRef.current?.emit('join-room', {
        roomId,
        passcode,
        participantName,
        participantEmail,
        isHost: isHost || false,
      });
      setConnectionStatus('Connected');
    } catch (err) {
      console.error('Error initializing call:', err);
      setError('Unable to start the call. Please refresh and try again.');
      setConnectionStatus('Failed');
    }
  }, [roomId, location.state, setupSocketListeners]);

  // 9. stopScreenShare ── defined before toggleScreenShare which calls it.
  const stopScreenShare = useCallback(async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
    }
    setIsScreenSharing(false);
    for (const peer of peersRef.current.values()) {
      const sender = peer.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && localStreamRef.current) {
        await sender.replaceTrack(localStreamRef.current.getVideoTracks()[0]);
      }
    }
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, []);

  // 10. toggleScreenShare ── depends on isScreenSharing + stopScreenShare.
  const toggleScreenShare = useCallback(async () => {
    try {
      if (!isScreenSharing) {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        screenStreamRef.current = screenStream;
        setIsScreenSharing(true);
        for (const peer of peersRef.current.values()) {
          const sender = peer.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) await sender.replaceTrack(screenStream.getVideoTracks()[0]);
        }
        if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;
        screenStream.getVideoTracks()[0].onended = () => stopScreenShare();
      } else {
        stopScreenShare();
      }
    } catch (err) {
      console.error('Error toggling screen share:', err);
    }
  }, [isScreenSharing, stopScreenShare]);

  // 11. Main useEffect ── all deps defined above.
  useEffect(() => {
    if (!location.state || !location.state.participantName) { navigate('/'); return; }
    const { participantName, participantEmail, passcode } = location.state;
    if (!participantName || !participantEmail || !passcode) { navigate('/'); return; }
    initializeCall();
    return () => { cleanup(); };
  }, [initializeCall, cleanup, location.state, navigate]);

  // ── Remaining callbacks (no ordering constraint among themselves) ─────────

  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
        socketRef.current?.emit('toggle-video', { isEnabled: videoTrack.enabled });
      }
    }
  }, []);

  const toggleAudio = useCallback(() => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
        socketRef.current?.emit('toggle-audio', { isEnabled: audioTrack.enabled });
      }
    }
  }, []);

  const toggleRaiseHand = useCallback(() => {
    const newState = !hasRaisedHand;
    setHasRaisedHand(newState);
    socketRef.current?.emit('toggle-raise-hand', { isRaised: newState });
  }, [hasRaisedHand]);

  const sendReaction = useCallback((reaction) => {
    socketRef.current?.emit('send-reaction', { reaction });
  }, []);

  const sendChatMessage = useCallback(() => {
    if (newMessage.trim()) {
      socketRef.current?.emit('send-chat-message', { message: newMessage.trim() });
      setNewMessage('');
    }
  }, [newMessage]);

  const refreshConnection = useCallback(() => {
    if (!socketRef.current || !socketRef.current.connected) {
      setConnectionStatus('Disconnected — cannot refresh');
      return;
    }
    setConnectionStatus('Refreshing...');
    peersRef.current.forEach(peer => peer.close());
    peersRef.current.clear();
    setRemoteStreams(new Map());
    setTimeout(() => {
      participants.forEach(p => createPeerConnection(p.id, p, true));
      setConnectionStatus('Connected');
    }, 1000);
  }, [participants, createPeerConnection]);

  const getStats = useCallback(() => {
    socketRef.current?.emit('get-room-stats');
    setShowStats(true);
  }, []);

  const startRecording = useCallback(async (type = 'both') => {
    try {
      const currentStream = isScreenSharing ? screenStreamRef.current : localStreamRef.current;
      let stream;
      if (type === 'video' || type === 'both') {
        stream = currentStream;
      } else if (type === 'audio') {
        stream = new MediaStream();
        const audioTrack = currentStream.getAudioTracks()[0];
        if (audioTrack) stream.addTrack(audioTrack);
      }
      if (!stream) throw new Error('No stream available for recording');
      recordingStreamRef.current = stream;
      const options = { mimeType: 'video/webm;codecs=vp9,opus' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'video/webm;codecs=vp8,opus';
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options.mimeType = 'video/webm';
          if (!MediaRecorder.isTypeSupported(options.mimeType)) options.mimeType = '';
        }
      }
      mediaRecorderRef.current = new MediaRecorder(stream, options);
      const chunks = [];
      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      mediaRecorderRef.current.onstop = () => {
        const blob = new Blob(chunks, { type: type === 'audio' ? 'audio/webm' : 'video/webm' });
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toLocaleString();
        const filename = `${type}_recording_${Date.now()}.webm`;
        setRecordings(prev => [
          ...prev,
          { id: Date.now(), type, url, blob, filename, timestamp, duration: 0 },
        ]);
        chunks.length = 0;
      };
      mediaRecorderRef.current.start(1000);
      setIsRecording(true);
    } catch (err) {
      console.error('Error starting recording:', err);
      alert('Failed to start recording. Please check your browser permissions.');
    }
  }, [isScreenSharing]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
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
  }, []);

  const deleteRecording = useCallback((recordingId) => {
    setRecordings(prev => {
      const recording = prev.find(r => r.id === recordingId);
      if (recording) URL.revokeObjectURL(recording.url);
      return prev.filter(r => r.id !== recordingId);
    });
  }, []);

  const leaveCall = useCallback(() => {
    cleanup();
    navigate('/');
  }, [cleanup, navigate]);

  const removeParticipant = useCallback((participantId) => {
    if (!isAdmin) { alert('Only the host can remove participants'); return; }
    const participant = participants.find(p => p.id === participantId);
    if (!participant) return;
    if (window.confirm(`Remove ${participant.name} from the meeting?\n\nThey will be immediately disconnected and cannot rejoin unless invited again.`)) {
      socketRef.current?.emit('admin-remove-participant', { participantId });
      setParticipants(prev => prev.filter(p => p.id !== participantId));
    }
  }, [isAdmin, participants]);

  const endMeeting = useCallback(() => {
    if (!isAdmin) { alert('Only the host can end the meeting'); return; }
    const count = participants.length;
    const confirmMessage = count > 0
      ? `End the meeting for all ${count + 1} participants?\n\nEveryone will be disconnected immediately.`
      : 'End the meeting?\n\nThe room will be closed.';
    if (window.confirm(confirmMessage)) {
      socketRef.current?.emit('admin-end-meeting');
      setConnectionStatus('Ending meeting...');
      setTimeout(() => { cleanup(); navigate('/'); }, 2000);
    }
  }, [isAdmin, participants.length, cleanup, navigate]);

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