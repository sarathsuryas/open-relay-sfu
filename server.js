const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const wrtc = require('wrtc');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server,
  {
    cors: {
      origin: "https://wrtc-angular.vercel.app",  // Or use "*" to allow all origins
      methods: ["GET", "POST"],
      credentials: true
    }
  }
);
app.use(cors({
  origin: 'https://wrtc-angular.vercel.app'    
}))

// Set EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/broadcast', (req, res) => {
  res.render('broadcast');
});

app.get('/view', (req, res) => {
  res.render('viewer');
});

app.get('/', (req, res) => {
  res.redirect('/view');
});

// WebRTC and Socket.io handling
let broadcaster = null;
const viewers = new Map(); // Map to store viewer connections
let broadcasterStream = null; // Store the broadcaster's MediaStream

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // When a broadcaster connects
  socket.on('broadcaster', async () => {
    // If there's already a broadcaster, disconnect the previous one
    if (broadcaster) {
      io.to(broadcaster).emit('broadcaster_exists');
    }
    
    broadcaster = socket.id;
    console.log('Broadcaster connected:', broadcaster);
    
    // Let all viewers know a broadcaster is available
    socket.broadcast.emit('broadcaster_connected');
  });

  // Handle offer from broadcaster
  socket.on('broadcaster_offer', async (description) => {
    if (socket.id !== broadcaster) return;
    
    try {
      // Close any existing peer connection
      if (socket.peerConnection) {
        socket.peerConnection.close();
      }
      
      const peerConnection = new wrtc.RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.stunprotocol.org:3478' },
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      });
      
      // Create a new MediaStream to hold the broadcaster's tracks
      broadcasterStream = new wrtc.MediaStream();
      
      // Store broadcaster's tracks when they are received
      peerConnection.ontrack = (event) => {
        console.log('Received track from broadcaster:', event.track.kind);
        
        // Add the track to our broadcasterStream
        broadcasterStream.addTrack(event.track);
        
        console.log(`Broadcaster stream now has ${broadcasterStream.getTracks().length} tracks`);
        console.log(`Track types: ${broadcasterStream.getTracks().map(t => t.kind).join(', ')}`);
        
        // Update all existing viewers with the new track
        updateAllViewers();
      };
      
      // Set up ICE handling
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('broadcaster_ice_candidate', event.candidate);
        }
      };
      
      // Log connection state changes for debugging
      peerConnection.onconnectionstatechange = () => {
        console.log(`Broadcaster connection state: ${peerConnection.connectionState}`);
        if (peerConnection.connectionState === 'connected') {
          console.log('Broadcaster fully connected!');
        }
      };
      
      peerConnection.oniceconnectionstatechange = () => {
        console.log(`Broadcaster ICE connection state: ${peerConnection.iceConnectionState}`);
      };
      
      await peerConnection.setRemoteDescription(description);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      
      // Send answer back to broadcaster
      socket.emit('broadcaster_answer', peerConnection.localDescription);
      
      // Save the peer connection
      socket.peerConnection = peerConnection;
      
      console.log('Broadcaster peer connection setup complete');
    } catch (error) {
      console.error('Error handling broadcaster offer:', error);
      socket.emit('error', { message: 'Failed to establish broadcaster connection' });
    }
  });

  // Handle ICE candidates from broadcaster
  socket.on('broadcaster_ice_candidate', (candidate) => {
    if (socket.id !== broadcaster || !socket.peerConnection) return;
    
    try {
      socket.peerConnection.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Error adding broadcaster ICE candidate:', error);
    }
  });

  // Handle viewer connection requests
  socket.on('viewer_request', async () => {
    if (!broadcaster) {
      socket.emit('no_broadcaster');
      return;
    }
    
    try {
      // Create a new RTCPeerConnection for this viewer
      const viewerPC = new wrtc.RTCPeerConnection({
        iceServers: [
            {
              urls: "stun:stun.relay.metered.ca:80",
            },
            {
              urls: "turn:global.relay.metered.ca:80",
              username: "f5baae95181d1a3b2947f791",
              credential: "n67tiC1skstIO4zc",
            },
            {
              urls: "turn:global.relay.metered.ca:80?transport=tcp",
              username: "f5baae95181d1a3b2947f791",
              credential: "n67tiC1skstIO4zc",
            },
            {
              urls: "turn:global.relay.metered.ca:443",
              username: "f5baae95181d1a3b2947f791",
              credential: "n67tiC1skstIO4zc",
            },
            {
              urls: "turns:global.relay.metered.ca:443?transport=tcp",
              username: "f5baae95181d1a3b2947f791",
              credential: "n67tiC1skstIO4zc",
            },
          ],
      });
      
      // Add this viewer to our map
      viewers.set(socket.id, viewerPC);
      
      // Handle ICE candidate events
      viewerPC.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('viewer_ice_candidate', event.candidate);
        }
      };
      
      // Log connection state changes for debugging
      viewerPC.onconnectionstatechange = () => {
        console.log(`Viewer ${socket.id} connection state: ${viewerPC.connectionState}`);
        if (viewerPC.connectionState === 'connected') {
          console.log(`Viewer ${socket.id} fully connected!`);
        }
      };
      
      viewerPC.oniceconnectionstatechange = () => {
        console.log(`Viewer ${socket.id} ICE connection state: ${viewerPC.iceConnectionState}`);
      };
      
      // Check if we have tracks to send
      let tracksAdded = false;
      
      if (broadcasterStream && broadcasterStream.getTracks().length > 0) {
        console.log(`Adding ${broadcasterStream.getTracks().length} tracks to viewer ${socket.id}`);
        
        // Important: Clone the MediaStream to ensure proper handling
        const viewerStream = new wrtc.MediaStream();
        
        // Add all tracks from broadcaster stream to viewer stream and peer connection
        broadcasterStream.getTracks().forEach(track => {
          console.log(`Adding ${track.kind} track to viewer ${socket.id}`);
          viewerPC.addTrack(track, viewerStream);
          tracksAdded = true;
        });
      }
      
      if (!tracksAdded) {
        console.warn('No tracks available to add to the viewer connection');
        socket.emit('error', { message: 'No broadcast stream available yet. Please try again in a moment.' });
        return;
      }
      
      // Create offer for viewer
      const offer = await viewerPC.createOffer();
      await viewerPC.setLocalDescription(offer);
      
      // Send offer to viewer
      socket.emit('viewer_offer', viewerPC.localDescription);
    } catch (error) {
      console.error('Error setting up viewer connection:', error);
      socket.emit('error', { message: 'Failed to establish viewer connection' });
    }
  });

  // Handle answer from viewer
  socket.on('viewer_answer', async (description) => {
    const viewerPC = viewers.get(socket.id);
    if (!viewerPC) return;
    
    try {
      await viewerPC.setRemoteDescription(description);
      console.log(`Viewer ${socket.id} answer processed successfully`);
    } catch (error) {
      console.error('Error setting viewer remote description:', error);
    }
  });

  // Handle ICE candidates from viewer
  socket.on('viewer_ice_candidate', (candidate) => {
    const viewerPC = viewers.get(socket.id);
    if (!viewerPC) return;
    
    try {
      viewerPC.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Error adding viewer ICE candidate:', error);
    }
  });

  // Handle disconnections
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    if (socket.id === broadcaster) {
      console.log('Broadcaster disconnected');
      broadcaster = null;
      
      // Clean up broadcaster peer connection
      if (socket.peerConnection) {
        socket.peerConnection.close();
        delete socket.peerConnection;
      }
      
      // Clear broadcaster stream
      if (broadcasterStream) {
        broadcasterStream.getTracks().forEach(track => track.stop());
        broadcasterStream = null;
      }
      
      // Notify all viewers that the broadcaster is gone
      io.emit('broadcaster_disconnected');
      
      // Close all viewer connections
      viewers.forEach((viewerPC) => {
        viewerPC.close();
      });
      viewers.clear();
    } else if (viewers.has(socket.id)) {
      console.log('Viewer disconnected:', socket.id);
      
      // Clean up viewer peer connection
      const viewerPC = viewers.get(socket.id);
      if (viewerPC) {
        viewerPC.close();
      }
      viewers.delete(socket.id);
    }
  });

  // Helper function to update all viewers with current broadcaster stream
  function updateAllViewers() {
    if (!broadcasterStream || broadcasterStream.getTracks().length === 0) {
      console.log('No broadcaster stream available to update viewers');
      return;
    }
    
    console.log(`Updating all viewers with ${broadcasterStream.getTracks().length} tracks`);
    
    viewers.forEach((viewerPC, viewerId) => {
      try {
        // Get current senders
        const senders = viewerPC.getSenders();
        const existingKinds = senders.map(sender => sender.track?.kind).filter(Boolean);
        
        // Check each track from broadcaster
        broadcasterStream.getTracks().forEach(track => {
          if (!existingKinds.includes(track.kind)) {
            console.log(`Adding ${track.kind} track to existing viewer ${viewerId}`);
            const stream = new wrtc.MediaStream();
            stream.addTrack(track);
            viewerPC.addTrack(track, stream);
          }
        });
      } catch (error) {
        console.error(`Error updating viewer ${viewerId}:`, error);
      }
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Broadcast page: http://localhost:${PORT}/broadcast`);
  console.log(`Viewer page: http://localhost:${PORT}/view`);
});