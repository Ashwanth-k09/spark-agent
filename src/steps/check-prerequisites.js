'use strict';
const chalk = require('chalk');
const ora   = require('ora');
const { runOnNode }    = require('../utils/ssh-executor');
const { analyzeError } = require('../utils/ai-analyzer');

const PREREQS = [
  { name: 'apt-transport-https', check: "dpkg -s apt-transport-https 2>&1 | grep -c 'Status: install'", install: 'sudo apt-get install -y apt-transport-https' },
  { name: 'ca-certificates',     check: "dpkg -s ca-certificates 2>&1 | grep -c 'Status: install'",     install: 'sudo apt-get install -y ca-certificates' },
  { name: 'curl',                check: 'curl --version 2>&1 | head -1',                                 install: 'sudo apt-get install -y curl' },
  { name: 'wget',                check: 'wget --version 2>&1 | head -1',                                 install: 'sudo apt-get install -y wget' },
  { name: 'Java 11 JDK',         check: 'java -version 2>&1 | head -1',                                 install: 'sudo apt-get install -y openjdk-11-jdk' },
  { name: 'Python3',             check: 'python3 --version 2>&1',                                       install: 'sudo apt-get install -y python3 python3-pip' },
  { name: 'Scala',               check: 'scala -version 2>&1 | head -1',                                install: 'sudo apt-get install -y scala' },
  { name: 'net-tools',           check: 'ifconfig --version 2>&1 | head -1',                            install: 'sudo apt-get install -y net-tools' },
];

// Safely extract ip and username from worker entry
// Supports both plain string "10.0.2.15" and object { ip, username }
function getNodeList(config) {
  const masterUser = config.masterUser || config.username;
  const nodes = [
    { label: 'Master', ip: config.masterIp, username: masterUser },
  ];
  config.workers.forEach((w, i) => {
    const ip       = typeof w === 'string' ? w : w.ip;
    const username = typeof w === 'string' ? masterUser : (w.username || masterUser);
    nodes.push({ label: `Worker ${i + 1}`, ip, username });
  });
  return nodes;
}

async function checkAndInstallPrereqs(config) {
  const allNodes = getNodeList(config);

  for (const node of allNodes) {
    // Safety check — skip if IP is missing or invalid
    if (!node.ip || typeof node.ip !== 'string') {
      console.log(chalk.red(`  ✗ Skipping ${node.label} — invalid IP: ${JSON.stringify(node.ip)}`));
      continue;
    }

    console.log(chalk.cyan(`\n🔧  Node: ${node.label}  (${node.username}@${node.ip})`));

    const updSpin = ora('  Running apt-get update...').start();
    const upd = await runOnNode(node.ip, node.username,
      'sudo apt-get update -y 2>&1 | tail -2', config.sshKeyPath);
    upd.success
      ? updSpin.succeed(chalk.green('  apt-get update done'))
      : updSpin.fail(chalk.red('  apt-get update failed: ' + upd.stderr));

    for (const prereq of PREREQS) {
      const spin = ora(`  Checking ${prereq.name}...`).start();
      const chk  = await runOnNode(node.ip, node.username, prereq.check, config.sshKeyPath);

      const missing =
        !chk.success ||
        chk.stdout.trim() === '0' ||
        chk.stdout.includes('not found') ||
        chk.stderr.includes('not found') ||
        chk.stderr.includes('command not found');

      if (!missing) {
        spin.succeed(chalk.green(
          `  ✓ ${prereq.name}: ${(chk.stdout || chk.stderr).trim().slice(0, 60)}`
        ));
        continue;
      }

      spin.text = `  Installing ${prereq.name}...`;
      const inst = await runOnNode(node.ip, node.username, prereq.install, config.sshKeyPath);

      if (inst.success) {
        spin.succeed(chalk.green(`  ✓ ${prereq.name} installed`));
      } else {
        spin.fail(chalk.red(`  ✗ ${prereq.name} failed`));
        console.log(chalk.yellow('  🤖 Groq AI + Rule Engine analyzing...'));
        try {
          const { ruleMatch, aiAnalysis } = await analyzeError(
            inst.stderr || inst.stdout,
            `Installing ${prereq.name} on ${node.label} (${node.username}@${node.ip})`
          );
          if (ruleMatch) {
            console.log(chalk.magenta(`     [${ruleMatch.id}] ${ruleMatch.label} → applying fix...`));
            await runOnNode(node.ip, node.username, ruleMatch.fix, config.sshKeyPath);
            const retry = await runOnNode(node.ip, node.username, prereq.install, config.sshKeyPath);
            retry.success
              ? console.log(chalk.green(`     ✓ ${prereq.name} installed after fix`))
              : console.log(chalk.red(`     ✗ still failing`));
          }
          if (aiAnalysis.fix_command && !ruleMatch) {
            await runOnNode(node.ip, node.username, aiAnalysis.fix_command, config.sshKeyPath);
          }
          aiAnalysis.solution_steps?.forEach((s, i) =>
            console.log(chalk.blue(`     ${i + 1}. ${s}`))
          );
        } catch (e) {
          console.log(chalk.gray(`     AI unavailable: ${e.message}`));
        }
      }
    }
  }
}

module.exports = { checkAndInstallPrereqs };
