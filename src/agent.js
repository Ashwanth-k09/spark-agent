#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const chalk = require('chalk');
const { collectConfig }               = require('./steps/collect-config');
const { checkAndInstallPrereqs }      = require('./steps/check-prerequisites');
const { installSpark }                = require('./steps/install-spark');
const { configureCluster }            = require('./steps/configure-cluster');
const { startCluster, verifyCluster } = require('./steps/start-verify');
const { setupNewSSH, testConnection, runOnNode } = require('./utils/ssh-executor');
const { analyzeError }                = require('./utils/ai-analyzer');
const { RULES }                       = require('./rules/rule-engine');

function printBanner() {
  console.clear();
  console.log(chalk.cyan('╔══════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('║') + chalk.yellow('        ⚡  SPARK CLUSTER AI AGENT  ⚡             ') + chalk.cyan('║'));
  console.log(chalk.cyan('║') + chalk.white('  AI Model  : Llama 3.3 70B via Groq API           ') + chalk.cyan('║'));
  console.log(chalk.cyan('║') + chalk.white('  SSH       : Auto-starts SSH on all nodes          ') + chalk.cyan('║'));
  console.log(chalk.cyan('║') + chalk.white('  Workers   : Configurable — 1 to 20 nodes          ') + chalk.cyan('║'));
  console.log(chalk.cyan('║') + chalk.white('  Rules     : 10 auto-fix rules loaded              ') + chalk.cyan('║'));
  console.log(chalk.cyan('╚══════════════════════════════════════════════════════╝'));
  console.log('');
}

function printStepHeader(num, total, title) {
  console.log('\n' + chalk.bgCyan.black(` STEP ${num}/${total}: ${title} `) + '\n');
}

// ── Ensure SSH service is running on a node ───────────────────
async function ensureSSHRunning(ip, username, keyPath, label) {
  const chalk = require('chalk');
  const ora   = require('ora');

  const spin = ora(`  Checking SSH service on ${label} (${ip})...`).start();

  // Check if SSH is running
  const check = await runOnNode(ip, username,
    'sudo systemctl is-active ssh 2>/dev/null || sudo systemctl is-active sshd 2>/dev/null || echo "inactive"',
    keyPath
  );

  if (check.stdout.trim() === 'active') {
    spin.succeed(chalk.green(`  ✓ SSH service running on ${label} (${ip})`));
    return;
  }

  // SSH not running — start it
  spin.text = `  Starting SSH service on ${label} (${ip})...`;

  const start = await runOnNode(ip, username,
    'sudo systemctl start ssh 2>/dev/null || sudo systemctl start sshd 2>/dev/null && sudo systemctl enable ssh 2>/dev/null || sudo systemctl enable sshd 2>/dev/null && echo "SSH_STARTED"',
    keyPath
  );

  if (start.stdout.includes('SSH_STARTED') || start.code === 0) {
    spin.succeed(chalk.green(`  ✓ SSH service started on ${label} (${ip})`));
  } else {
    // Try installing openssh-server if not present
    spin.text = `  Installing SSH server on ${label} (${ip})...`;
    const install = await runOnNode(ip, username,
      'sudo apt-get install -y openssh-server && sudo systemctl start ssh && sudo systemctl enable ssh && echo "SSH_INSTALLED"',
      keyPath
    );
    install.stdout.includes('SSH_INSTALLED')
      ? spin.succeed(chalk.green(`  ✓ SSH installed and started on ${label} (${ip})`))
      : spin.fail(chalk.red(`  ✗ Could not start SSH on ${label} (${ip}): ${install.stderr}`));
  }
}

async function main() {
  printBanner();

  if (!process.env.GROQ_API_KEY ||
      process.env.GROQ_API_KEY === 'your_groq_api_key_here') {
    console.log(chalk.red('✗  GROQ_API_KEY not set in .env'));
    console.log(chalk.yellow('   Edit ~/spark-ai-agent/.env and add your key'));
    console.log(chalk.gray('   Get key: https://console.groq.com\n'));
    process.exit(1);
  }

  console.log(chalk.green('✓  Groq AI ready  (llama-3.3-70b-versatile)'));
  console.log(chalk.green(`✓  ${RULES.length} rule-engine rules loaded\n`));

  try {
    // ── STEP 1 ────────────────────────────────────────────────
    printStepHeader(1, 6, 'COLLECT CLUSTER CONFIGURATION');
    const config = await collectConfig();

    // Print topology
    console.log(chalk.cyan('\n📊  Cluster Topology:'));
    console.log(chalk.yellow(`  SSH key  : ${config.sshKeyPath}`));
    console.log(chalk.yellow(`  MASTER   : ${config.masterUser || config.username}@${config.masterIp}:${config.sparkPort}`));
    config.workers.forEach((w, i) => {
      const ip   = typeof w === 'string' ? w : w.ip;
      const user = typeof w === 'string' ? (config.masterUser || config.username) : w.username;
      console.log(chalk.magenta(`  WORKER ${i + 1} : ${user}@${ip}`));
    });

    // ── STEP 2 ────────────────────────────────────────────────
    printStepHeader(2, 6, 'SSH SETUP & START SSH ON ALL NODES');

    // Distribute SSH key if new mode
    if (config.sshMode === 'new') {
      console.log(chalk.yellow('  Distributing SSH key to all nodes...\n'));
      const ok = await setupNewSSH(config);
      if (!ok) {
        console.log(chalk.red('  ✗ SSH key distribution failed'));
        process.exit(1);
      }
    } else {
      console.log(chalk.green('  ✓ Using existing SSH keys\n'));
    }

    // ── Start SSH service on master ───────────────────────────
    const masterUser = config.masterUser || config.username;
    console.log(chalk.cyan('  Ensuring SSH service is running on all nodes...\n'));

    await ensureSSHRunning(
      config.masterIp,
      masterUser,
      config.sshKeyPath,
      'Master'
    );

    // ── Start SSH service on all workers ─────────────────────
    for (let i = 0; i < config.workers.length; i++) {
      const w        = config.workers[i];
      const ip       = typeof w === 'string' ? w : w.ip;
      const workerUser = typeof w === 'string' ? masterUser : (w.username || masterUser);

      await ensureSSHRunning(
        ip,
        workerUser,
        config.sshKeyPath,
        `Worker ${i + 1}`
      );
    }

    // ── Test connectivity to all nodes ────────────────────────
    console.log(chalk.cyan('\n  Testing SSH connectivity to all nodes...\n'));
    let allOk = true;

    const masterTest = await testConnection(config.masterIp, masterUser, config.sshKeyPath);
    if (masterTest.stdout.includes('CONN_OK')) {
      console.log(chalk.green(`  ✓ Master connected → ${masterUser}@${config.masterIp}`));
    } else {
      console.log(chalk.red(`  ✗ Master failed → ${masterUser}@${config.masterIp}: ${masterTest.stderr}`));
      allOk = false;
    }

    for (let i = 0; i < config.workers.length; i++) {
      const w          = config.workers[i];
      const ip         = typeof w === 'string' ? w : w.ip;
      const workerUser = typeof w === 'string' ? masterUser : (w.username || masterUser);

      const test = await testConnection(ip, workerUser, config.sshKeyPath);
      if (test.stdout.includes('CONN_OK')) {
        console.log(chalk.green(`  ✓ Worker ${i + 1} connected → ${workerUser}@${ip}`));
      } else {
        console.log(chalk.red(`  ✗ Worker ${i + 1} failed → ${workerUser}@${ip}: ${test.stderr}`));
        allOk = false;
      }
    }

    if (!allOk) {
      console.log(chalk.red('\n  ✗ Some nodes unreachable. Fix SSH then re-run.\n'));
      process.exit(1);
    }

    console.log(chalk.green('\n  ✓ All nodes connected and SSH running\n'));

    // ── STEP 3 ────────────────────────────────────────────────
    printStepHeader(3, 6, 'CHECK & AUTO-INSTALL PREREQUISITES');
    await checkAndInstallPrereqs(config);

    // ── STEP 4 ────────────────────────────────────────────────
    printStepHeader(4, 6, 'INSTALL SPARK ON ALL NODES');
    await installSpark(config);

    // ── STEP 5 ────────────────────────────────────────────────
    printStepHeader(5, 6, 'CONFIGURE MASTER AND WORKERS');
    await configureCluster(config);

    // ── STEP 6 ────────────────────────────────────────────────
    printStepHeader(6, 6, 'START CLUSTER & VERIFY');
    await startCluster(config);
    await verifyCluster(config);

    console.log(chalk.bgGreen.black('\n  ✅  SPARK CLUSTER IS READY  \n'));

  } catch (err) {
    console.log(chalk.red(`\n✗  Unexpected error: ${err.message}`));
    console.log(chalk.yellow('🤖  Groq AI analyzing...\n'));
    try {
      const { ruleMatch, aiAnalysis } = await analyzeError(err.message, 'Main agent loop');
      if (ruleMatch) console.log(chalk.magenta(`[${ruleMatch.id}] Fix: ${ruleMatch.fix}`));
      console.log(chalk.blue('Root cause: ' + aiAnalysis.root_cause));
      aiAnalysis.solution_steps?.forEach((s, i) =>
        console.log(chalk.blue(`  ${i + 1}. ${s}`))
      );
    } catch (e) {
      console.log(chalk.gray('AI unavailable: ' + e.message));
    }
    process.exit(1);
  }
}

main();
