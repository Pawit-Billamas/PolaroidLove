// server.js
// Serves the static frontend AND runs the WebRTC signaling server (PeerJS)
// that lets two devices find each other using a short room code.
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Simple health check, useful for uptime monitors / platform checks
app.get('/health', (req, res) => res.json({ ok: true }));

// ICE server config, served to the frontend at runtime.
// Ships with free public STUN servers, which is enough for most
// home-wifi <-> home-wifi or wifi <-> mobile-data pairings.
// To add a TURN server for tougher networks (hotel wifi, campus firewalls),
// just set TURN_URL / TURN_USERNAME / TURN_CREDENTIAL as env vars —
// no code changes needed. See README for how to get free TURN credentials.
app.get('/ice-config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  res.json({ iceServers });
});

// Static frontend (public/index.html, style.css, app.js)
app.use(express.static(path.join(__dirname, 'public')));

// WebRTC signaling server, mounted at /peerjs.
// The frontend gives each session a short room code (e.g. "PINK-42"),
// and that code IS the PeerJS peer id — so "connecting with a code"
// is literally two browsers registering/dialing that same id.
const peerServer = ExpressPeerServer(server, {
  path: '/',
  allow_discovery: false,
  proxied: true // trust platform's reverse proxy (Render/Railway/etc.) for correct protocol detection
});
app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => {
  console.log(`[peerjs] connected: ${client.getId()}`);
});
peerServer.on('disconnect', (client) => {
  console.log(`[peerjs] disconnected: ${client.getId()}`);
});

server.listen(PORT, () => {
  console.log(`Polaroid Love listening on port ${PORT}`);
});
