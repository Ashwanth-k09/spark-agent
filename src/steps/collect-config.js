'use strict';
const inquirer = require('inquirer');
const chalk    = require('chalk');
const ora      = require('ora');
const os       = require('os');
const fs       = require('fs');
const { execSync } = require('child_process');
const {
  findExistingKey,
  getKnownHosts,
  testAllConnections,
  addNodeToSSH,
} = require('../utils/ssh-executor');
const {
  loadConnections,
  saveConnection,
  deleteConnection,
  deleteAllConnections,
  getStorePath,
} = require('../utils/connection-store');

const isValidIp = v =>
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) || 'Invalid IP address format';

function detectUsername() {
  try { return execSync('whoami', { encoding: 'utf8' }).trim(); }
  catch (_) { return os.userInfo().username; }
}

// Print saved connections in a table
function printSavedConnections(connections) {
  console.log(chalk.cyan('\n  Saved connections:\n'));
  connections.forEach((c, i) => {
    console.log(chalk.yellow(`  [${i + 1}] Master: ${c.masterUser}@${c.masterIp}:${c.sparkPort}`));
    c.workers.forEach((w, j) => {
      const ip   = typeof w === 'string' ? w : w.ip;
      const user = typeof w === 'string' ? c.masterUser : (w.username || c.masterUser);
      console.log(chalk.gray(`       Worker ${j + 1}: ${user}@${ip}`));
    });
    console.log(chalk.gray(`       SSH key : ${c.sshKeyPath}`));
    console.log(chalk.gray(`       Saved   : ${c.savedAt || c.updatedAt || 'unknown'}\n`));
  });
}

async function collectConfig() {
  console.log(chalk.cyan('\n🌐  CLUSTER NETWORK CONFIGURATION\n'));

  const savedConnections = loadConnections();
  const keyPath          = findExistingKey();
  const username         = detectUsername();

  // ── If saved connections exist — show them first ──────────
  if (savedConnections.length > 0) {
    console.log(chalk.green(`  ✓ Found ${savedConnections.length} saved connection(s) at ${getStorePath()}\n`));
    printSavedConnections(savedConnections);

    const { action } = await inquirer.prompt([{
      type:    'list',
      name:    'action',
      message: 'What would you like to do?',
      choices: [
        { name: 'Use a saved connection',     value: 'use'    },
        { name: 'Create a new connection',    value: 'new'    },
        { name: 'Delete a saved connection',  value: 'delete' },
        { name: 'Delete all connections',     value: 'deleteAll' },
      ],
    }]);

    // ── USE SAVED CONNECTION ──────────────────────────────────
    if (action === 'use') {
      let selectedConfig;

      if (savedConnections.length === 1) {
        selectedConfig = savedConnections[0];
        console.log(chalk.green(`\n  ✓ Using saved connection: ${selectedConfig.masterUser}@${selectedConfig.masterIp}\n`));
      } else {
        const { selectedMaster } = await inquirer.prompt([{
          type:    'list',
          name:    'selectedMaster',
          message: 'Which connection do you want to use?',
          choices: savedConnections.map(c => ({
            name:  `${c.masterUser}@${c.masterIp}  (${c.workers.length} worker(s))`,
            value: c.masterIp,
          })),
        }]);
        selectedConfig = savedConnections.find(c => c.masterIp === selectedMaster);
      }

      // Ask if they want to add more nodes to this connection
      const { addMore } = await inquirer.prompt([{
        type:    'confirm',
        name:    'addMore',
        message: 'Do you want to add new nodes to this connection?',
        default: false,
      }]);

      if (addMore) {
        const { extraCount } = await inquirer.prompt([{
          type:     'input',
          name:     'extraCount',
          message:  'How many new nodes to add?',
          validate: v => (Number.isInteger(Number(v)) && Number(v) >= 1) || 'Enter a valid number',
          filter:   v => Number(v),
        }]);

        const pubKeyPath = `${selectedConfig.sshKeyPath}.pub`;
        const newWorkers = [];

        for (let i = 1; i <= extraCount; i++) {
          const ans = await inquirer.prompt([
            {
              type:     'input',
              name:     'ip',
              message:  `New node ${i} IP address:`,
              validate: isValidIp,
            },
            {
              type:    'input',
              name:    'nodeUser',
              message: `New node ${i} username:`,
              default: selectedConfig.masterUser,
            },
            {
              type:     'password',
              name:     'password',
              message:  `New node ${i} SSH password:`,
              mask:     '*',
              validate: v => v.length > 0 || 'Password cannot be empty',
            },
          ]);

          const addSpin = ora(`  Adding ${ans.nodeUser}@${ans.ip}...`).start();
          const added   = await addNodeToSSH(ans.ip, ans.nodeUser, ans.password, pubKeyPath);

          if (added) {
            addSpin.succeed(chalk.green(`  ✓ Node added: ${ans.nodeUser}@${ans.ip}`));
            newWorkers.push({ ip: ans.ip, username: ans.nodeUser });
          } else {
            addSpin.fail(chalk.red(`  ✗ Failed to add ${ans.ip}`));
          }
        }

        // Add new workers to the config
        selectedConfig = {
          ...selectedConfig,
          workers:     [...selectedConfig.workers, ...newWorkers],
          workerCount: selectedConfig.workers.length + newWorkers.length,
        };

        // Save updated config
        saveConnection(selectedConfig);
        console.log(chalk.green(`\n  ✓ Connection updated and saved\n`));
      }

      return selectedConfig;
    }

    // ── DELETE ONE CONNECTION ─────────────────────────────────
    if (action === 'delete') {
      const { toDelete } = await inquirer.prompt([{
        type:    'list',
        name:    'toDelete',
        message: 'Which connection do you want to delete?',
        choices: savedConnections.map(c => ({
          name:  `${c.masterUser}@${c.masterIp}  (${c.workers.length} worker(s))`,
          value: c.masterIp,
        })),
      }]);

      deleteConnection(toDelete);
      console.log(chalk.green(`\n  ✓ Connection ${toDelete} deleted\n`));

      // If connections remain ask what to do next
      const remaining = loadConnections();
      if (remaining.length > 0) {
        const { next } = await inquirer.prompt([{
          type:    'list',
          name:    'next',
          message: 'What would you like to do now?',
          choices: [
            { name: 'Use a remaining connection', value: 'use' },
            { name: 'Create a new connection',    value: 'new' },
            { name: 'Exit',                       value: 'exit' },
          ],
        }]);

        if (next === 'exit') process.exit(0);
        if (next === 'use') {
          const { selectedMaster } = await inquirer.prompt([{
            type:    'list',
            name:    'selectedMaster',
            message: 'Which connection?',
            choices: remaining.map(c => ({
              name:  `${c.masterUser}@${c.masterIp}`,
              value: c.masterIp,
            })),
          }]);
          return remaining.find(c => c.masterIp === selectedMaster);
        }
      } else {
        console.log(chalk.yellow('  No connections remaining. Creating new one...\n'));
      }
    }

    // ── DELETE ALL CONNECTIONS ────────────────────────────────
    if (action === 'deleteAll') {
      const { confirm } = await inquirer.prompt([{
        type:    'confirm',
        name:    'confirm',
        message: 'Are you sure you want to delete ALL saved connections?',
        default: false,
      }]);

      if (confirm) {
        deleteAllConnections();
        console.log(chalk.green('  ✓ All connections deleted\n'));
      } else {
        console.log(chalk.yellow('  Cancelled. Restarting...\n'));
        return collectConfig();
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  //  CREATE NEW CONNECTION
  // ════════════════════════════════════════════════════════════
  console.log(chalk.cyan('  Creating new connection...\n'));

  // SSH mode
  const { sshMode } = await inquirer.prompt([{
    type:    'list',
    name:    'sshMode',
    message: 'SSH setup:',
    choices: [
      { name: 'Use existing SSH connection', value: 'existing' },
      { name: 'Create new SSH key pair',     value: 'new'      },
    ],
  }]);

  let password   = '';
  let sshKeyPath = keyPath || `${os.homedir()}/.ssh/id_rsa`;

  if (sshMode === 'existing') {
    if (!keyPath) {
      console.log(chalk.red('  ✗ No SSH key found.'));
      console.log(chalk.yellow('  Run: ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N ""'));
      process.exit(1);
    }
    console.log(chalk.green(`  ✓ Using existing key: ${keyPath}\n`));
    sshKeyPath = keyPath;
  } else {
    sshKeyPath = `${os.homedir()}/.ssh/spark_agent_rsa`;
    const { pw } = await inquirer.prompt([{
      type:     'password',
      name:     'pw',
      message:  'SSH password (used once to distribute key):',
      mask:     '*',
      validate: v => v.length > 0 || 'Password cannot be empty',
    }]);
    password = pw;
  }

  // Username
  const { confirmedUser } = await inquirer.prompt([{
    type:    'input',
    name:    'confirmedUser',
    message: 'SSH username for all nodes:',
    default: username,
  }]);

  // Worker count
  const { workerCount } = await inquirer.prompt([{
    type:    'list',
    name:    'workerCount',
    message: 'How many WORKER nodes?',
    choices: [
      { name: '1 worker',  value: 1 },
      { name: '2 workers', value: 2 },
      { name: '3 workers', value: 3 },
      { name: '4 workers', value: 4 },
      { name: '5 workers', value: 5 },
      { name: '6 workers', value: 6 },
      { name: '8 workers', value: 8 },
      { name: 'Custom...', value: 'custom' },
    ],
  }]);

  let finalCount = workerCount;
  if (workerCount === 'custom') {
    const { n } = await inquirer.prompt([{
      type:     'input',
      name:     'n',
      message:  'Enter number of workers (1–20):',
      validate: v => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 20) || 'Enter 1–20',
      filter:   v => Number(v),
    }]);
    finalCount = n;
  }

  // Master IP
  const { masterIp } = await inquirer.prompt([{
    type:     'input',
    name:     'masterIp',
    message:  'Enter MASTER node IP address:',
    validate: isValidIp,
  }]);

  // Worker IPs
  const workers = [];
  for (let i = 1; i <= finalCount; i++) {
    const ans = await inquirer.prompt([
      {
        type:     'input',
        name:     'ip',
        message:  `Enter WORKER ${i} IP address:`,
        validate: isValidIp,
      },
      {
        type:    'input',
        name:    'workerUser',
        message: `Enter WORKER ${i} username:`,
        default: confirmedUser,
      },
    ]);
    workers.push({ ip: ans.ip, username: ans.workerUser });
  }

  // Spark ports
  const ports = await inquirer.prompt([
    { type: 'input', name: 'sparkPort', message: 'Spark master port:', default: '7077' },
    { type: 'input', name: 'webUiPort', message: 'Spark Web UI port:', default: '8080' },
  ]);

  const newConfig = {
    masterIp,
    masterUser:  confirmedUser,
    username:    confirmedUser,
    sshMode,
    sshKeyPath,
    workerCount: finalCount,
    workers,
    sparkPort:   ports.sparkPort,
    webUiPort:   ports.webUiPort,
    password,
  };

  // Save the new connection
  saveConnection(newConfig);
  console.log(chalk.green(`\n  ✓ Connection saved to ${getStorePath()}\n`));

  return newConfig;
}

module.exports = { collectConfig };
