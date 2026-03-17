'use strict';
const chalk = require('chalk');
const ora   = require('ora');
const { runOnNode }    = require('../utils/ssh-executor');
const { analyzeError } = require('../utils/ai-analyzer');

const SPARK_VERSION     = '3.5.0';
const HADOOP_VER        = '3';
const SPARK_URL_PRIMARY = `https://archive.apache.org/dist/spark/spark-${SPARK_VERSION}/spark-${SPARK_VERSION}-bin-hadoop${HADOOP_VER}.tgz`;
const SPARK_URL_BACKUP  = `https://dlcdn.apache.org/spark/spark-${SPARK_VERSION}/spark-${SPARK_VERSION}-bin-hadoop${HADOOP_VER}.tgz`;

function buildInstallScript() {
  return `
set -e

# Already installed — skip
if [ -d "/opt/spark" ]; then
  echo "ALREADY_INSTALLED"
  exit 0
fi

# Download to /tmp — always writable, no sudo needed
cd /tmp
echo "Downloading Spark to /tmp..."

wget --tries=2 --timeout=60 "${SPARK_URL_PRIMARY}" -O /tmp/spark.tgz 2>&1
PRIMARY_EXIT=$?

if [ $PRIMARY_EXIT -ne 0 ]; then
  echo "Primary URL failed, trying backup..."
  rm -f /tmp/spark.tgz
  wget --tries=2 --timeout=60 "${SPARK_URL_BACKUP}" -O /tmp/spark.tgz 2>&1
  BACKUP_EXIT=$?
  if [ $BACKUP_EXIT -ne 0 ]; then
    echo "DOWNLOAD_FAILED"
    rm -f /tmp/spark.tgz
    exit 1
  fi
fi

# Verify file size
FILE_SIZE=$(stat -c%s /tmp/spark.tgz 2>/dev/null || echo 0)
if [ "$FILE_SIZE" -lt 1000000 ]; then
  echo "DOWNLOAD_FAILED: file too small ($FILE_SIZE bytes)"
  rm -f /tmp/spark.tgz
  exit 1
fi

echo "Download OK. Size: $FILE_SIZE bytes"

# Extract to /tmp first
echo "Extracting..."
cd /tmp
tar -xzf /tmp/spark.tgz
if [ $? -ne 0 ]; then
  echo "EXTRACT_FAILED"
  rm -f /tmp/spark.tgz
  exit 1
fi

# Move extracted folder to /opt/spark
sudo mv /tmp/spark-${SPARK_VERSION}-bin-hadoop${HADOOP_VER} /opt/spark
rm -f /tmp/spark.tgz

# Fix ownership
sudo chown -R $USER:$USER /opt/spark
chmod -R 755 /opt/spark

# Add to PATH
grep -qxF 'export SPARK_HOME=/opt/spark' ~/.bashrc \
  || echo 'export SPARK_HOME=/opt/spark' >> ~/.bashrc
grep -qF 'SPARK_HOME/bin' ~/.bashrc \
  || echo 'export PATH=$PATH:$SPARK_HOME/bin:$SPARK_HOME/sbin' >> ~/.bashrc

# Set JAVA_HOME
JHOME=$(readlink -f /usr/bin/java | sed 's:/bin/java::')
grep -qF "JAVA_HOME" ~/.bashrc \
  || echo "export JAVA_HOME=$JHOME" >> ~/.bashrc

# Verify
if [ ! -f "/opt/spark/bin/spark-submit" ]; then
  echo "VERIFY_FAILED: spark-submit not found"
  exit 1
fi

echo "INSTALLED_OK"
`;
}

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

async function installSpark(config) {
  const allNodes = getNodeList(config);

  for (const node of allNodes) {
    if (!node.ip) {
      console.log(chalk.red(`  ✗ Skipping ${node.label} — IP is missing`));
      continue;
    }

    const spin = ora(`  Installing Spark on ${node.label} (${node.username}@${node.ip})...`).start();
    const res  = await runOnNode(node.ip, node.username, buildInstallScript(), config.sshKeyPath);

    if (res.stdout.includes('ALREADY_INSTALLED')) {
      spin.succeed(chalk.green(`  ✓ Spark already installed on ${node.label}`));
      continue;
    }

    if (res.stdout.includes('INSTALLED_OK')) {
      spin.succeed(chalk.green(`  ✓ Spark ${SPARK_VERSION} installed on ${node.label}`));
      continue;
    }

    // Failed — show full output
    spin.fail(chalk.red(`  ✗ Spark install failed on ${node.label}`));
    console.log(chalk.red('  ── stdout ───────────────────────────'));
    console.log(res.stdout || '  (empty)');
    console.log(chalk.red('  ── stderr ───────────────────────────'));
    console.log(res.stderr || '  (empty)');
    console.log(chalk.red('  ─────────────────────────────────────\n'));

    // Specific error hints
    if (res.stdout.includes('Permission denied') || res.stderr.includes('Permission denied')) {
      console.log(chalk.yellow('  Permission fix — run this on the node:'));
      console.log(chalk.white(`  ssh ${node.username}@${node.ip} "sudo chown -R $USER:$USER /opt && sudo chmod 755 /opt"`));
    }

    if (res.stdout.includes('DOWNLOAD_FAILED')) {
      console.log(chalk.yellow('  Internet may be down on this node. Test:'));
      console.log(chalk.white(`  ssh ${node.username}@${node.ip} "ping -c 2 8.8.8.8"`));
    }

    // AI analysis
    console.log(chalk.yellow('  🤖 Groq AI analyzing...'));
    try {
      const { ruleMatch, aiAnalysis } = await analyzeError(
        res.stderr || res.stdout,
        `Spark install on ${node.label}`
      );
      if (ruleMatch) {
        console.log(chalk.magenta(`  [${ruleMatch.id}] ${ruleMatch.label} → applying fix...`));
        await runOnNode(node.ip, node.username, ruleMatch.fix, config.sshKeyPath);
        const retry = await runOnNode(node.ip, node.username, buildInstallScript(), config.sshKeyPath);
        if (retry.stdout.includes('INSTALLED_OK')) {
          console.log(chalk.green('  ✓ Spark installed after fix'));
          continue;
        }
      }
      if (aiAnalysis.fix_command) {
        console.log(chalk.blue(`  Groq fix: ${aiAnalysis.fix_command}`));
      }
      console.log(chalk.blue(`  Root cause : ${aiAnalysis.root_cause}`));
      aiAnalysis.solution_steps?.forEach((s, i) =>
        console.log(chalk.blue(`  ${i + 1}. ${s}`))
      );
    } catch (e) {
      console.log(chalk.gray(`  AI unavailable: ${e.message}`));
    }
  }
}

module.exports = { installSpark };
