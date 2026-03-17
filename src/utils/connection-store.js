'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const STORE_PATH = path.join(os.homedir(), '.spark-agent-connections.json');

// Load all saved connections
function loadConnections() {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const data = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (_) {
    return [];
  }
}

// Save a new connection
function saveConnection(connection) {
  const connections = loadConnections();

  // Check if same masterIp already exists — update it
  const existingIndex = connections.findIndex(c => c.masterIp === connection.masterIp);
  if (existingIndex >= 0) {
    connections[existingIndex] = { ...connection, updatedAt: new Date().toISOString() };
  } else {
    connections.push({ ...connection, savedAt: new Date().toISOString() });
  }

  fs.writeFileSync(STORE_PATH, JSON.stringify(connections, null, 2));
  return connections;
}

// Delete a connection by masterIp
function deleteConnection(masterIp) {
  const connections = loadConnections();
  const filtered    = connections.filter(c => c.masterIp !== masterIp);
  fs.writeFileSync(STORE_PATH, JSON.stringify(filtered, null, 2));
  return filtered;
}

// Delete all connections
function deleteAllConnections() {
  fs.writeFileSync(STORE_PATH, JSON.stringify([], null, 2));
}

// Get store file path
function getStorePath() {
  return STORE_PATH;
}

module.exports = {
  loadConnections,
  saveConnection,
  deleteConnection,
  deleteAllConnections,
  getStorePath,
};
