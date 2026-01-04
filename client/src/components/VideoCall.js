import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import { SOCKET_URL } from '../config';
import './VideoCall.css';

function VideoCall() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  
  // Log configuration on component mount
  useEffect(() => {
    console.log('🎥 VideoCall component loaded');
    console.log('🔌 Socket URL:', SOCKET_URL);
  }, []);
  
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
  const [showAudioWarning, setShowAudioWarning] = useState(false);
  const [audioDevices, setAudioDevices] = useState([]);
  
  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingType, setRecordingType] = useState('both'); // 'video', 'audio', 'both'
  const [recordedChunks, setRecordedChunks] = useState([]);
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
      console.log('❌ No participant data found, redirecting to home');
      navigate('/');
      return;
    }

    // Check if this is a valid join attempt (not just page refresh)
    const { participantName, participantEmail, passcode } = location.state;
    if (!participantName || !participantEmail || !passcode) {
      console.log('❌ Incomplete participant data, redirecting to home');
      navigate('/');
      return;
    }

    console.log('✅ Valid join attempt detected, initializing call');
    initializeCall();

    return () => {
      cleanup();
    };
  }, []);

  const initializeCall = async () => {
    try {
      console.log('🚀 Initializing video call...');
      
      // Clean up any existing socket connection first
      if (socketRef.current) {
        console.log('🧹 Cleaning up existing socket connection');
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      
      // Initialize socket connection
      socketRef.current = io(SOCKET_URL, {
        forceNew: true, // Force new connection
        transports: ['websocket', 'polling']
      });
      
      // Get user media with enhanced audio settings
      const mediaConstraints = {
        video: { 
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 60 },
          facingMode: 'user'
        },
        audio: {
          // Enhanced audio settings for better quality
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: { ideal: 48000 },
          channelCount: { ideal: 1 },
          volume: { ideal: 1.0 },
          // Additional constraints for better audio
          googEchoCancellation: true,
          googAutoGainControl: true,
          googNoiseSuppression: true,
          googHighpassFilter: true,
          googTypingNoiseDetection: true,
          googAudioMirroring: false
        }
      };

      console.log('📹 Requesting media with enhanced constraints:', mediaConstraints);
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);

      console.log('📹 Local stream obtained');
      setLocalStream(stream);
      localStreamRef.current = stream;
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Detect audio devices and show warning if no headphones
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
        setAudioDevices(audioOutputs);
        
        // Check if likely using speakers (show warning)
        const hasHeadphones = audioOutputs.some(device => 
          device.label.toLowerCase().includes('headphone') ||
          device.label.toLowerCase().includes('headset') ||
          device.label.toLowerCase().includes('earphone')
        );
        
        if (!hasHeadphones && audioOutputs.length > 0) {
          setShowAudioWarning(true);
          // Auto-hide warning after 10 seconds
          setTimeout(() => setShowAudioWarning(false), 10000);
        }
      } catch (err) {
        console.log('Could not enumerate devices:', err);
      }

      setupSocketListeners();

      // Join room after getting media
      const { participantName, participantEmail, passcode, isHost } = location.state;
      console.log(`🏠 Joining room ${roomId} as ${participantName} (${isHost ? 'ADMIN' : 'PARTICIPANT'})`);
      
      socketRef.current.emit('join-room', {
        roomId,
        passcode,
        participantName,
        participantEmail,
        isHost: isHost || false
      });

      setConnectionStatus('Connected');

    } catch (error) {
      console.error('❌ Error initializing call:', error);
      setError('Unable to access camera/microphone. Please check permissions.');
      setConnectionStatus('Failed');
    }
  };

  const setupSocketListeners = () => {
    const socket = socketRef.current;

    socket.on('room-joined', ({ room, isAdmin: adminStatus }) => {
      console.log('✅ Successfully joined room:', room);
      console.log('📊 Existing participants received:', room.participants);
      console.log('👑 Admin status:', adminStatus);
      
      setRoomInfo(room);
      setIsAdmin(adminStatus);
      
      // CRITICAL: Clear any existing state first
      setParticipants([]);
      setRemoteStreams(new Map());
      peersRef.current.clear();
      
      // Set ONLY the existing participants (excluding self) with connection status
      const existingParticipants = (room.participants || []).map(p => ({
        ...p,
        connectionStatus: 'connecting'
      }));
      console.log(`📊 Setting ${existingParticipants.length} existing participants`);
      setParticipants(existingParticipants);
      setParticipantCount(existingParticipants.length + 1); // +1 for self
      
      setChatMessages(room.chatMessages || []);
      setRaisedHands(room.raisedHands || []);
      
      // Create peer connections ONLY for existing participants with a delay
      existingParticipants.forEach((participant, index) => {
        console.log(`🤝 Creating peer connection for existing participant: ${participant.name} (${participant.id})`);
        // Stagger connection creation to avoid overwhelming
        setTimeout(() => {
          createPeerConnection(participant.id, participant, true);
        }, index * 200);
      });
    });

    socket.on('user-joined', (participant) => {
      console.log('👋 New user joined:', participant);
      
      // Prevent duplicate participants
      setParticipants(prev => {
        const exists = prev.find(p => p.id === participant.id);
        if (exists) {
          console.log('⚠️ Participant already exists, skipping:', participant.name);
          return prev;
        }
        
        console.log('📊 Adding participant to list. Current:', prev.length, 'Adding:', participant.name);
        const newParticipant = { ...participant, connectionStatus: 'connecting' };
        const newList = [...prev, newParticipant];
        setParticipantCount(newList.length + 1); // +1 for self
        return newList;
      });
      
      // Create peer connection for new participant (they will initiate)
      if (!peersRef.current.has(participant.id)) {
        createPeerConnection(participant.id, participant, false);
      }
    });

    socket.on('participant-count-updated', ({ count }) => {
      console.log('📊 Participant count updated from server:', count);
      setParticipantCount(count);
      
      // Verify our local state matches server count
      setParticipants(prev => {
        const localCount = prev.length + 1; // +1 for self
        if (localCount !== count) {
          console.log(`⚠️ Count mismatch! Local: ${localCount}, Server: ${count}`);
        }
        return prev;
      });
    });

    socket.on('user-left', (userId) => {
      console.log('👋 User left:', userId);
      
      // Remove from participants
      setParticipants(prev => {
        const filtered = prev.filter(p => p.id !== userId);
        console.log('📊 Removing participant. Before:', prev.length, 'After:', filtered.length);
        setParticipantCount(filtered.length + 1); // +1 for self
        return filtered;
      });
      
      // Clean up peer connection
      const peer = peersRef.current.get(userId);
      if (peer) {
        peer.close();
        peersRef.current.delete(userId);
        console.log(`🔌 Closed peer connection for ${userId}`);
      }
      
      // Remove remote stream
      setRemoteStreams(prev => {
        const newStreams = new Map(prev);
        newStreams.delete(userId);
        console.log(`🗑️ Removed remote stream for ${userId}`);
        return newStreams;
      });
    });

    // Admin-specific event handlers
    socket.on('force-disconnect', ({ reason, message }) => {
      console.log('🚫 Force disconnected:', reason);
      alert(message);
      cleanup();
      navigate('/');
    });

    socket.on('meeting-ended', ({ reason, message, endedBy }) => {
      console.log('🔚 Meeting ended:', reason);
      alert(`${message}${endedBy ? ` by ${endedBy}` : ''}`);
      cleanup();
      navigate('/');
    });

    socket.on('participant-removed', ({ participantId, participantName, removedBy }) => {
      console.log(`🚫 Participant ${participantName} was removed by ${removedBy}`);
      
      // Immediately remove from participants list
      setParticipants(prev => {
        const filtered = prev.filter(p => p.id !== participantId);
        console.log(`📊 Participant removed. Before: ${prev.length}, After: ${filtered.length}`);
        setParticipantCount(filtered.length + 1); // +1 for self
        return filtered;
      });
      
      // Clean up peer connection immediately
      const peer = peersRef.current.get(participantId);
      if (peer) {
        peer.close();
        peersRef.current.delete(participantId);
        console.log(`🔌 Closed peer connection for removed participant ${participantId}`);
      }
      
      // Remove remote stream immediately
      setRemoteStreams(prev => {
        const newStreams = new Map(prev);
        newStreams.delete(participantId);
        console.log(`🗑️ Removed remote stream for ${participantId}`);
        return newStreams;
      });
      
      // Show notification if not admin
      if (!isAdmin) {
        // Show a brief notification about the removal
        setTimeout(() => {
          console.log(`ℹ️ ${participantName} was removed from the meeting`);
        }, 100);
      }
    });

    // WebRTC signaling handlers
    socket.on('offer', async ({ offer, senderId }) => {
      console.log(`📥 Received offer from ${senderId}`);
      await handleOffer(offer, senderId);
    });

    socket.on('answer', async ({ answer, senderId }) => {
      console.log(`📥 Received answer from ${senderId}`);
      await handleAnswer(answer, senderId);
    });

    socket.on('ice-candidate', async ({ candidate, senderId }) => {
      console.log(`🧊 Received ICE candidate from ${senderId}`);
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
      console.error('❌ Socket error:', message);
      setError(message);
      setConnectionStatus('Error');
    });

    socket.on('connect', () => {
      console.log('🔗 Socket connected');
      setConnectionStatus('Connected');
    });

    socket.on('disconnect', () => {
      console.log('🔌 Socket disconnected');
      setConnectionStatus('Disconnected');
    });
  };

  const createPeerConnection = (peerId, participant, shouldCreateOffer) => {
    console.log(`🔗 Creating peer connection for ${participant.name} (${peerId}), shouldCreateOffer: ${shouldCreateOffer}`);
    
    // Check if peer connection already exists
    if (peersRef.current.has(peerId)) {
      console.log(`⚠️ Peer connection already exists for ${peerId}, skipping`);
      return;
    }
    
    // Enhanced ICE servers with TURN servers for better connectivity
    const iceServers = [
      // Google STUN servers
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      
      // Additional STUN servers for redundancy
      { urls: 'stun:stun.stunprotocol.org:3478' },
      { urls: 'stun:stun.voiparound.com' },
      { urls: 'stun:stun.voipbuster.com' },
      
      // Free TURN servers (you should replace with your own for production)
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ];
    
    const peer = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 10, // Pre-gather ICE candidates
      iceTransportPolicy: 'all', // Use both STUN and TURN
      bundlePolicy: 'max-bundle', // Bundle media for better performance
      rtcpMuxPolicy: 'require' // Multiplex RTP and RTCP
    });

    // Add local stream tracks with optimized settings
    const currentStream = isScreenSharing ? screenStreamRef.current : localStreamRef.current;
    if (currentStream) {
      currentStream.getTracks().forEach(track => {
        // Configure track settings for better quality
        if (track.kind === 'audio') {
          // Apply audio constraints for better quality
          track.applyConstraints({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            channelCount: 1
          }).catch(err => console.log('Audio constraints not applied:', err));
        }
        
        peer.addTrack(track, currentStream);
        console.log(`➕ Added ${track.kind} track to peer connection for ${peerId}`);
      });
    }

    // Handle remote stream with connection status tracking
    peer.ontrack = (event) => {
      console.log(`📺 Received remote stream from ${peerId}:`, event.streams[0]);
      const [remoteStream] = event.streams;
      
      setRemoteStreams(prev => {
        const newStreams = new Map(prev);
        newStreams.set(peerId, remoteStream);
        console.log(`💾 Stored remote stream for ${peerId}. Total streams:`, newStreams.size);
        return newStreams;
      });
      
      // Update connection status for this peer
      setParticipants(prev => prev.map(p => 
        p.id === peerId ? { ...p, connectionStatus: 'connected' } : p
      ));
    };

    // Enhanced ICE candidate handling with immediate sending
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`🧊 Sending ICE candidate to ${peerId}:`, event.candidate.type);
        socketRef.current.emit('ice-candidate', {
          candidate: event.candidate,
          targetId: peerId
        });
      } else {
        console.log(`🧊 ICE gathering complete for ${peerId}`);
      }
    };

    // Enhanced connection state monitoring
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      console.log(`🔄 Connection state for ${peerId}: ${state}`);
      
      // Update participant connection status
      setParticipants(prev => prev.map(p => 
        p.id === peerId ? { ...p, connectionStatus: state } : p
      ));
      
      if (state === 'connected') {
        console.log(`✅ Peer connection established with ${peerId}`);
      } else if (state === 'failed' || state === 'disconnected') {
        console.log(`❌ Peer connection failed for ${peerId}, attempting reconnection`);
        // Attempt reconnection after a delay
        setTimeout(() => {
          if (peersRef.current.has(peerId)) {
            console.log(`🔄 Attempting to reconnect to ${peerId}`);
            peersRef.current.delete(peerId);
            setRemoteStreams(prev => {
              const newStreams = new Map(prev);
              newStreams.delete(peerId);
              return newStreams;
            });
            // Recreate connection
            createPeerConnection(peerId, participant, true);
          }
        }, 3000);
      }
    };

    peer.oniceconnectionstatechange = () => {
      const iceState = peer.iceConnectionState;
      console.log(`🧊 ICE connection state for ${peerId}: ${iceState}`);
      
      if (iceState === 'connected' || iceState === 'completed') {
        console.log(`✅ ICE connection established with ${peerId}`);
      } else if (iceState === 'failed') {
        console.log(`❌ ICE connection failed for ${peerId}`);
      }
    };

    // Monitor ICE gathering state
    peer.onicegatheringstatechange = () => {
      console.log(`🧊 ICE gathering state for ${peerId}: ${peer.iceGatheringState}`);
    };

    // Store peer connection
    peersRef.current.set(peerId, peer);

    // Set initial connection status
    setParticipants(prev => prev.map(p => 
      p.id === peerId ? { ...p, connectionStatus: 'connecting' } : p
    ));

    // Create offer if we should initiate
    if (shouldCreateOffer) {
      // Add a small delay to ensure ICE gathering starts
      setTimeout(() => {
        createOffer(peerId);
      }, 100);
    }
  };

  const createOffer = async (peerId) => {
    try {
      const peer = peersRef.current.get(peerId);
      if (!peer) return;

      console.log(`📤 Creating offer for ${peerId}`);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      
      socketRef.current.emit('offer', {
        offer: offer,
        targetId: peerId
      });
      
      console.log(`📤 Offer sent to ${peerId}`);
    } catch (error) {
      console.error(`❌ Error creating offer for ${peerId}:`, error);
    }
  };

  const handleOffer = async (offer, senderId) => {
    try {
      let peer = peersRef.current.get(senderId);
      
      // Create peer connection if it doesn't exist
      if (!peer) {
        console.log(`🔗 Creating peer connection for incoming offer from ${senderId}`);
        const participant = participants.find(p => p.id === senderId) || { id: senderId, name: 'Unknown' };
        createPeerConnection(senderId, participant, false);
        peer = peersRef.current.get(senderId);
      }

      if (!peer) {
        console.error(`❌ No peer connection found for ${senderId}`);
        return;
      }

      console.log(`📥 Processing offer from ${senderId}`);
      await peer.setRemoteDescription(new RTCSessionDescription(offer));
      
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      
      socketRef.current.emit('answer', {
        answer: answer,
        targetId: senderId
      });
      
      console.log(`📤 Answer sent to ${senderId}`);
    } catch (error) {
      console.error(`❌ Error handling offer from ${senderId}:`, error);
    }
  };

  const handleAnswer = async (answer, senderId) => {
    try {
      const peer = peersRef.current.get(senderId);
      if (!peer) {
        console.error(`❌ No peer connection found for ${senderId}`);
        return;
      }

      console.log(`📥 Processing answer from ${senderId}`);
      await peer.setRemoteDescription(new RTCSessionDescription(answer));
      console.log(`✅ Answer processed from ${senderId}`);
    } catch (error) {
      console.error(`❌ Error handling answer from ${senderId}:`, error);
    }
  };

  const handleIceCandidate = async (candidate, senderId) => {
    try {
      const peer = peersRef.current.get(senderId);
      if (!peer) {
        console.error(`❌ No peer connection found for ${senderId}`);
        return;
      }

      await peer.addIceCandidate(new RTCIceCandidate(candidate));
      console.log(`✅ ICE candidate added for ${senderId}`);
    } catch (error) {
      console.error(`❌ Error adding ICE candidate from ${senderId}:`, error);
    }
  };

  // Media control functions
  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
        socketRef.current.emit('toggle-video', { isEnabled: videoTrack.enabled });
        console.log(`📹 Video ${videoTrack.enabled ? 'enabled' : 'disabled'}`);
      }
    }
  }, []);

  const toggleAudio = useCallback(() => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
        socketRef.current.emit('toggle-audio', { isEnabled: audioTrack.enabled });
        console.log(`🎤 Audio ${audioTrack.enabled ? 'enabled' : 'disabled'}`);
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
    socketRef.current.emit('toggle-raise-hand', { isRaised: newState });
  }, [hasRaisedHand]);

  const sendReaction = useCallback((reaction) => {
    socketRef.current.emit('send-reaction', { reaction });
  }, []);

  const sendChatMessage = useCallback(() => {
    if (newMessage.trim()) {
      socketRef.current.emit('send-chat-message', { message: newMessage.trim() });
      setNewMessage('');
    }
  }, [newMessage]);

  const refreshConnection = useCallback(() => {
    setConnectionStatus('Refreshing...');
    console.log('🔄 Refreshing connections...');
    console.log('📊 Current participants:', participants.length);
    console.log('📊 Current peer connections:', peersRef.current.size);
    console.log('📊 Current remote streams:', remoteStreams.size);
    
    // Close all peer connections
    peersRef.current.forEach((peer, peerId) => {
      console.log(`🔌 Closing peer connection for ${peerId}`);
      peer.close();
    });
    peersRef.current.clear();
    setRemoteStreams(new Map());
    
    // Reconnect after a short delay
    setTimeout(() => {
      console.log('🔄 Recreating peer connections...');
      participants.forEach(participant => {
        console.log(`🤝 Recreating peer connection for ${participant.name}`);
        createPeerConnection(participant.id, participant, true);
      });
      setConnectionStatus('Connected');
    }, 1000);
  }, [participants]);

  const getStats = useCallback(() => {
    socketRef.current.emit('get-room-stats');
    setShowStats(true);
  }, []);

  // Recording functions
  const startRecording = useCallback(async (type = 'both') => {
    try {
      console.log(`🎥 Starting ${type} recording...`);
      
      let stream;
      const currentStream = isScreenSharing ? screenStreamRef.current : localStreamRef.current;
      
      if (type === 'video' || type === 'both') {
        // Record video (and audio if 'both')
        const constraints = {
          video: true,
          audio: type === 'both'
        };
        stream = currentStream;
      } else if (type === 'audio') {
        // Record audio only
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
      setRecordingType(type);
      
      // Create MediaRecorder
      const options = {
        mimeType: 'video/webm;codecs=vp9,opus'
      };
      
      // Fallback for different browsers
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
        console.log('🎥 Recording stopped, processing...');
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
          duration: 0 // Will be calculated when played
        };

        setRecordings(prev => [...prev, newRecording]);
        console.log(`✅ Recording saved: ${filename}`);
        
        // Clear chunks
        chunks.length = 0;
      };

      mediaRecorderRef.current.start(1000); // Collect data every second
      setIsRecording(true);
      setRecordedChunks([]);
      
      console.log(`✅ ${type} recording started`);
      
    } catch (error) {
      console.error('❌ Error starting recording:', error);
      alert('Failed to start recording. Please check your browser permissions.');
    }
  }, [isScreenSharing]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      console.log('🛑 Stopping recording...');
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      console.log('✅ Recording stopped');
    }
  }, [isRecording]);

  const downloadRecording = useCallback((recording) => {
    const link = document.createElement('a');
    link.href = recording.url;
    link.download = recording.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    console.log(`📥 Downloaded: ${recording.filename}`);
  }, []);

  const deleteRecording = useCallback((recordingId) => {
    setRecordings(prev => {
      const recording = prev.find(r => r.id === recordingId);
      if (recording) {
        URL.revokeObjectURL(recording.url);
        console.log(`🗑️ Deleted recording: ${recording.filename}`);
      }
      return prev.filter(r => r.id !== recordingId);
    });
  }, []);

  const leaveCall = useCallback(() => {
    console.log('👋 Leaving call...');
    cleanup();
    navigate('/');
  }, [navigate]);

  // Admin-only functions
  const removeParticipant = useCallback((participantId) => {
    if (!isAdmin) {
      console.log('❌ Only admin can remove participants');
      alert('Only the host can remove participants');
      return;
    }
    
    const participant = participants.find(p => p.id === participantId);
    if (!participant) {
      console.log('❌ Participant not found');
      return;
    }
    
    if (window.confirm(`Remove ${participant.name} from the meeting?\n\nThey will be immediately disconnected and cannot rejoin unless invited again.`)) {
      console.log('👑 Admin removing participant:', participantId);
      socketRef.current.emit('admin-remove-participant', { participantId });
      
      // Optimistically update UI (will be confirmed by server event)
      setParticipants(prev => prev.filter(p => p.id !== participantId));
    }
  }, [isAdmin, participants]);

  const endMeeting = useCallback(() => {
    if (!isAdmin) {
      console.log('❌ Only admin can end meeting');
      alert('Only the host can end the meeting');
      return;
    }
    
    const participantCount = participants.length;
    const confirmMessage = participantCount > 0 
      ? `End the meeting for all ${participantCount + 1} participants?\n\nEveryone will be disconnected immediately.`
      : 'End the meeting?\n\nThe room will be closed.';
    
    if (window.confirm(confirmMessage)) {
      console.log('👑 Admin ending meeting');
      socketRef.current.emit('admin-end-meeting');
      
      // Show ending message
      setConnectionStatus('Ending meeting...');
      
      // Clean up and navigate after a brief delay
      setTimeout(() => {
        cleanup();
        navigate('/');
      }, 2000);
    }
  }, [isAdmin, participants.length, navigate]);

  const cleanup = () => {
    console.log('🧹 Cleaning up...');
    
    // Stop recording if active
    if (isRecording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    
    // Stop local stream
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log(`🛑 Stopped ${track.kind} track`);
      });
    }
    
    // Stop screen share stream
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
    }
    
    // Close all peer connections
    peersRef.current.forEach((peer, peerId) => {
      peer.close();
      console.log(`🔌 Closed peer connection for ${peerId}`);
    });
    peersRef.current.clear();
    
    // Disconnect socket
    if (socketRef.current) {
      socketRef.current.disconnect();
      console.log('🔌 Socket disconnected');
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
      {/* Audio Feedback Warning */}
      {showAudioWarning && (
        <div className="audio-warning">
          <div className="warning-content">
            <div className="warning-icon">🎧</div>
            <div className="warning-text">
              <h3>Use Headphones for Better Audio</h3>
              <p>To prevent echo and feedback, please use headphones or earphones during the call.</p>
            </div>
            <button 
              className="warning-close"
              onClick={() => setShowAudioWarning(false)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="video-call-header">
        <div className="room-info">
          <h2>Room: {roomId} {isAdmin && <span className="admin-crown">👑</span>}</h2>
          {roomInfo && <p>Host: {roomInfo.creatorName}</p>}
          <p>Participants: {participantCount}</p>
        </div>
        <div className="connection-info">
          <div className="connection-quality">
            <span className="quality-label">Connection:</span>
            <div className="quality-bars">
              <div className="bar bar-1 active"></div>
              <div className="bar bar-2 active"></div>
              <div className="bar bar-3 active"></div>
              <div className="bar bar-4"></div>
            </div>
          </div>
          <div className="connection-status">
            <span className={`status-indicator ${connectionStatus.toLowerCase()}`}>
              {connectionStatus}
            </span>
          </div>
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

          {/* Remote videos - ONLY render actual participants with valid data */}
          {participants
            .filter(participant => participant && participant.id && participant.name)
            .map((participant, index) => {
              const remoteStream = remoteStreams.get(participant.id);
              console.log(`🎥 Rendering participant: ${participant.name} (${participant.id}), hasStream: ${!!remoteStream}`);
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
      console.log(`📺 Remote video set for ${participant.name}`);
    } else {
      setIsStreamActive(false);
    }
  }, [stream, participant.name]);

  const colorClass = `remote-video-${(index % 6) + 1}`;
  const hasRaisedHand = raisedHands.some(h => h.participantId === participant.id);
  const connectionStatus = participant.connectionStatus || 'connecting';

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
      </div>
      
      {/* Connection Status Overlay */}
      {(!isStreamActive || connectionStatus === 'connecting') && (
        <div className="loading-overlay">
          <div className="loading-spinner"></div>
          <p>
            {connectionStatus === 'connecting' && 'Connecting to '}
            {connectionStatus === 'connected' && !isStreamActive && 'Loading video from '}
            {connectionStatus === 'failed' && 'Connection failed with '}
            {connectionStatus === 'disconnected' && 'Reconnecting to '}
            {participant.name}...
          </p>
          <div className="connection-status-indicator">
            <span className={`status-dot ${connectionStatus}`}></span>
            <span className="status-text">{connectionStatus}</span>
          </div>
        </div>
      )}
      
      <div className="participant-status-overlay">
        {!participant.isVideoEnabled && <span className="status-icon">📹❌</span>}
        {!participant.isAudioEnabled && <span className="status-icon">🎤❌</span>}
        {connectionStatus === 'connected' && isStreamActive && (
          <span className="status-icon connected">🟢</span>
        )}
      </div>
    </div>
  );
});

export default VideoCall;