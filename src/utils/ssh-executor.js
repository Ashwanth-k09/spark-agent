'use strict';
const { NodeSSH } = require('node-ssh');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

function findExistingKey() {
  const homeDir  = os.homedir();
  const keyNames = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];
  for (const name of keyNames) {
    const p = `${homeDir}/.ssh/${name}`;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Read all IPs from ~/.ssh/known_hosts
function getKnownHosts() {
  const knownHostsPath = `${os.homedir()}/.ssh/known_hosts`;
  if (!fs.existsSync(knownHostsPath)) return [];

  const lines = fs.readFileSync(knownHostsPath, 'utf8').split('\n');
  const ips   = [];

  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;

    // Each line starts with hostname/ip — could be hashed or plain
    const firstPart = line.split(' ')[0];

    // Skip hashed entries (start with |1|)
    if (firstPart.startsWith('|')) continue;

    // Could be comma-separated: "ip1,ip2 key..."
    const hosts = firstPart.split(',');
    for (const host of hosts) {
      // Only keep plain IPs (skip hostnames)
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
        if (!ips.includes(host)) ips.push(host);
      }
    }
  }

  return ips;
}

// Test SSH connection to a node
async function testConnection(ip, username, keyPath) {
  return runOnNode(ip, username, 'echo CONN_OK && hostname', keyPath);
}

// Test multiple nodes and return which ones are reachable
async function testAllConnections(ips, username, keyPath) {
  const results = [];
  for (const ip of ips) {
    const res = await testConnection(ip, username, keyPath);
    results.push({
      ip,
      connected: res.stdout.includes('CONN_OK'),
      hostname:  res.stdout.split('\n')[1]?.trim() || ip,
      error:     res.stderr,
    });
  }
  return results;
}

// Add a new node to known_hosts by SSH-ing into it once
async function addNodeToSSH(ip, username, password, pubKeyPath) {
  const ssh    = new NodeSSH();
  const pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim();

  try {
    await ssh.connect({ host: ip, username, password, readyTimeout: 15000 });
    const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${pubKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo "NODE_ADDED"`;
    const res = await ssh.execCommand(cmd);
    ssh.dispose();
    return res.stdout.includes('NODE_ADDED');
  } catch (err) {
    return false;
  }
}

async function runOnNode(ip, username, command, keyPath) {
  const ssh = new NodeSSH();
  const key = keyPath || findExistingKey();
  const opts = { host: ip, username, readyTimeout: 15000 };
  if (key) opts.privateKeyPath = key;

  try {
    await ssh.connect(opts);
    const result = await ssh.execCommand(command);
    ssh.dispose();
    return {
      success: result.code === 0,
      stdout:  result.stdout || '',
      stderr:  result.stderr || '',
      code:    result.code,
    };
  } catch (err) {
    return { success: false, stdout: '', stderr: err.message, code: -1 };
  }
}

async function runOnNodeWithPassword(ip, username, password, command) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: ip, username, password, readyTimeout: 15000 });
    const result = await ssh.execCommand(command);
    ssh.dispose();
    return {
      success: result.code === 0,
      stdout:  result.stdout || '',
      stderr:  result.stderr || '',
      code:    result.code,
    };
  } catch (err) {
    return { success: false, stdout: '', stderr: err.message, code: -1 };
  }
}

async function setupNewSSH(config) {
  const chalk = require('chalk');
  const ora   = require('ora');
  const keyPath = config.sshKeyPath;
  const pubPath = `${keyPath}.pub`;

  if (!fs.existsSync(keyPath)) {
    const spin = ora('  Generating new SSH key pair...').start();
    try {
      execSync(`ssh-keygen -t rsa -b 4096 -f "${keyPath}" -N "" -q`, { stdio: 'pipe' });
      spin.succeed(chalk.green(`  ✓ SSH key generated: ${keyPath}`));
    } catch (err) {
      spin.fail(chalk.red('  ✗ Key generation failed: ' + err.message));
      return false;
    }
  } else {
    console.log(chalk.green(`  ✓ SSH key already exists: ${keyPath}`));
  }

  const pubKey = fs.readFileSync(pubPath, 'utf8').trim();
  const allNodes = [
    { label: 'Master', ip: config.masterIp, username: config.masterUser || config.username },
    ...config.workers.map((w, i) => ({
      label:    `Worker ${i + 1}`,
      ip:       typeof w === 'string' ? w : w.ip,
      username: typeof w === 'string'
        ? (config.masterUser || config.username)
        : (w.username || config.masterUser || config.username),
    })),
  ];

  for (const node of allNodes) {
    const spin = ora(`  Distributing key to ${node.label} (${node.username}@${node.ip})...`).start();
    const cmd  = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${pubKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo "KEY_OK"`;
    const res  = await runOnNodeWithPassword(node.ip, node.username, config.password, cmd);
    res.stdout.includes('KEY_OK')
      ? spin.succeed(chalk.green(`  ✓ Key distributed to ${node.label}`))
      : spin.fail(chalk.red(`  ✗ Failed on ${node.label}: ${res.stderr}`));
  }
  return true;
}

module.exports = {
  runOnNode,
  runOnNodeWithPassword,
  setupNewSSH,
  testConnection,
  testAllConnections,
  addNodeToSSH,
  findExistingKey,
  getKnownHosts,
};
