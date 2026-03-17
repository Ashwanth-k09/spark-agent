'use strict';
const chalk = require('chalk');
const ora   = require('ora');
const Table = require('cli-table3');
const { runOnNode }    = require('../utils/ssh-executor');
const { analyzeError } = require('../utils/ai-analyzer');

function getNodeList(config) {
  const masterUser = config.masterUser || config.username;
  return config.workers.map((w, i) => ({
    label:     `Worker ${i + 1}`,
    ip:        typeof w === 'string' ? w : w.ip,
    username:  typeof w === 'string' ? masterUser : (w.username || masterUser),
    webuiPort: 8081 + i,
  }));
}

async function forceStopAll(ip, username, keyPath, label) {
  const spin = ora(`  Stopping Spark on ${label} (${ip})...`).start();
  await runOnNode(ip, username,
    'pkill -9 -f spark 2>/dev/null; pkill -9 -f "deploy.worker" 2>/dev/null; pkill -9 -f "deploy.master" 2>/dev/null; find /opt/spark -name "*.pid" -delete 2>/dev/null; sleep 1; echo STOPPED',
    keyPath
  );
  spin.succeed(chalk.green(`  ✓ Stopped on ${label}`));
  await new Promise(r => setTimeout(r, 1000));
}

async function waitForUI(ip, username, url, keyPath, timeoutSecs) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutSecs * 1000) {
    const res = await runOnNode(ip, username,
      `curl -s -o /dev/null -w "%{http_code}" ${url}`, keyPath);
    if (res.stdout.trim() === '200') return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function startCluster(config) {
  const masterUser = config.masterUser || config.username;
  const workers    = getNodeList(config);

  // ── Stop all ──────────────────────────────────────────────
  console.log(chalk.cyan('  Stopping any existing Spark processes...\n'));
  await forceStopAll(config.masterIp, masterUser, config.sshKeyPath, 'Master');
  for (const w of workers) {
    await forceStopAll(w.ip, w.username, config.sshKeyPath, w.label);
  }
  await new Promise(r => setTimeout(r, 2000));
  console.log('');

  // ── Write spark-env.sh on Master FIRST ───────────────────
  // This is the key fix — write the config file before starting
  // so Spark reads the correct IP instead of auto-detecting wrong one
  const writeEnvCmd = `
mkdir -p /opt/spark/conf /opt/spark/logs
cat > /opt/spark/conf/spark-env.sh << 'ENVEOF'
export SPARK_MASTER_HOST=${config.masterIp}
export SPARK_LOCAL_IP=${config.masterIp}
export SPARK_MASTER_PORT=${config.sparkPort}
export SPARK_MASTER_WEBUI_PORT=${config.webUiPort}
export JAVA_HOME=$(readlink -f /usr/bin/java | sed 's:/bin/java::')
export SPARK_HOME=/opt/spark
ENVEOF
echo "ENV_WRITTEN"
`;

  const envRes = await runOnNode(config.masterIp, masterUser, writeEnvCmd, config.sshKeyPath);
  if (envRes.stdout.includes('ENV_WRITTEN')) {
    console.log(chalk.green(`  ✓ spark-env.sh written → Master will bind to ${config.masterIp}\n`));
  }

  // ── Start Master ──────────────────────────────────────────
  const masterSpin = ora(`  Starting Master (${config.masterIp})...`).start();

  const startMasterCmd = `
export SPARK_HOME=/opt/spark
export JAVA_HOME=$(readlink -f /usr/bin/java | sed 's:/bin/java::')
unset SPARK_LOCAL_IP
nohup $SPARK_HOME/bin/spark-class org.apache.spark.deploy.master.Master \\
  --host ${config.masterIp} \\
  --port ${config.sparkPort} \\
  --webui-port ${config.webUiPort} \\
  > /opt/spark/logs/master.out 2>&1 &
sleep 2
echo "MASTER_STARTED"
`;

  const mRes = await runOnNode(config.masterIp, masterUser, startMasterCmd, config.sshKeyPath);

  if (mRes.stdout.includes('MASTER_STARTED')) {
    masterSpin.succeed(chalk.green('  ✓ Master process launched'));
  } else {
    masterSpin.fail(chalk.red('  ✗ Master failed: ' + mRes.stderr));
    return;
  }

  // Wait for Master UI
  const masterUISpin = ora('  Waiting for Master UI...').start();
  const masterUIUp   = await waitForUI(
    config.masterIp, masterUser,
    `http://${config.masterIp}:${config.webUiPort}`,
    config.sshKeyPath, 30
  );

  if (masterUIUp) {
    masterUISpin.succeed(chalk.green(`  ✓ Master UI ready → http://${config.masterIp}:${config.webUiPort}`));
  } else {
    masterUISpin.fail(chalk.red('  ✗ Master UI not responding after 30s'));
    const logs = await runOnNode(config.masterIp, masterUser,
      'tail -3 /opt/spark/logs/master.out 2>/dev/null | grep -E "Bound|ERROR|started"',
      config.sshKeyPath);
    console.log(chalk.red('  Master logs: ' + logs.stdout));
  }

  console.log('');

  // ── Write spark-env.sh on each Worker then start it ──────
  for (let i = 0; i < workers.length; i++) {
    const w = workers[i];

    // Write worker spark-env.sh with correct local IP
    const writeWorkerEnv = `
mkdir -p /opt/spark/conf /opt/spark/logs
cat > /opt/spark/conf/spark-env.sh << 'ENVEOF'
export SPARK_MASTER_HOST=${config.masterIp}
export SPARK_LOCAL_IP=${w.ip}
export SPARK_WORKER_WEBUI_PORT=${w.webuiPort}
export JAVA_HOME=$(readlink -f /usr/bin/java | sed 's:/bin/java::')
export SPARK_HOME=/opt/spark
ENVEOF
echo "WORKER_ENV_WRITTEN"
`;
    await runOnNode(w.ip, w.username, writeWorkerEnv, config.sshKeyPath);

    const spin = ora(`  Starting ${w.label} (${w.username}@${w.ip}) on port ${w.webuiPort}...`).start();

    const startWorkerCmd = `
export SPARK_HOME=/opt/spark
export JAVA_HOME=$(readlink -f /usr/bin/java | sed 's:/bin/java::')
unset SPARK_LOCAL_IP
nohup $SPARK_HOME/bin/spark-class org.apache.spark.deploy.worker.Worker \\
  --host ${w.ip} \\
  --webui-port ${w.webuiPort} \\
  spark://${config.masterIp}:${config.sparkPort} \\
  > /opt/spark/logs/worker-${i + 1}.out 2>&1 &
sleep 2
echo "WORKER_STARTED"
`;

    const wRes = await runOnNode(w.ip, w.username, startWorkerCmd, config.sshKeyPath);

    if (wRes.stdout.includes('WORKER_STARTED')) {
      spin.succeed(chalk.green(`  ✓ ${w.label} process launched`));
    } else {
      spin.fail(chalk.red(`  ✗ ${w.label} failed: ` + wRes.stderr));
      continue;
    }

    // Wait for Worker UI
    const workerUISpin = ora(`  Waiting for ${w.label} UI...`).start();
    const workerUIUp   = await waitForUI(
      w.ip, w.username,
      `http://${w.ip}:${w.webuiPort}`,
      config.sshKeyPath, 20
    );

    if (workerUIUp) {
      workerUISpin.succeed(chalk.green(`  ✓ ${w.label} UI ready → http://${w.ip}:${w.webuiPort}`));
    } else {
      workerUISpin.fail(chalk.yellow(`  ⚠ ${w.label} UI not responding`));
      const logs = await runOnNode(w.ip, w.username,
        `tail -3 /opt/spark/logs/worker-${i + 1}.out 2>/dev/null | grep -E "Bound|ERROR|started"`,
        config.sshKeyPath);
      console.log(chalk.gray('  Logs: ' + logs.stdout));
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(chalk.gray('\n  Waiting for workers to register with master...'));
  await new Promise(r => setTimeout(r, 4000));
}

async function verifyCluster(config) {
  console.log(chalk.cyan('\n🔍  Verifying cluster status...\n'));

  const masterUser = config.masterUser || config.username;
  const workers    = getNodeList(config);

  const table = new Table({
    head: [chalk.cyan('Node'), chalk.cyan('IP'), chalk.cyan('Status'), chalk.cyan('Web UI')],
    style: { border: ['cyan'] },
  });

  const mChk = await runOnNode(config.masterIp, masterUser,
    `curl -s -o /dev/null -w "%{http_code}" http://${config.masterIp}:${config.webUiPort}`,
    config.sshKeyPath);
  table.push([
    'Master', config.masterIp,
    mChk.stdout.trim() === '200' ? chalk.green('● RUNNING') : chalk.red('✗ DOWN'),
    `http://${config.masterIp}:${config.webUiPort}`,
  ]);

  for (const w of workers) {
    const wChk = await runOnNode(w.ip, w.username,
      `curl -s -o /dev/null -w "%{http_code}" http://${w.ip}:${w.webuiPort}`,
      config.sshKeyPath);
    table.push([
      w.label, w.ip,
      wChk.stdout.trim() === '200' ? chalk.green('● RUNNING') : chalk.red('✗ DOWN'),
      `http://${w.ip}:${w.webuiPort}`,
    ]);
  }

  console.log(table.toString());
  console.log(chalk.yellow(`\n  Spark URL : spark://${config.masterIp}:${config.sparkPort}`));
  console.log(chalk.yellow(`  Master UI : http://${config.masterIp}:${config.webUiPort}`));
  workers.forEach((w, i) =>
    console.log(chalk.yellow(`  Worker ${i + 1} UI : http://${w.ip}:${w.webuiPort}`))
  );
  console.log(chalk.green('\n  Test job:'));
  console.log(chalk.white(
    `  export SPARK_HOME=/opt/spark\n` +
    `  $SPARK_HOME/bin/spark-submit \\\n` +
    `    --master spark://${config.masterIp}:${config.sparkPort} \\\n` +
    `    --class org.apache.spark.examples.SparkPi \\\n` +
    `    $SPARK_HOME/examples/jars/spark-examples_2.12-3.5.0.jar 10\n`
  ));
}

module.exports = { startCluster, verifyCluster };
