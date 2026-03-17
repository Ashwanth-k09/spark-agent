'use strict';

const RULES = [
  {
    id: 'R001',
    label: 'Java Not Found',
    pattern: /java.*not found|java.*command not found|JAVA_HOME/i,
    description: 'Java JDK is missing on this node',
    fix: 'sudo apt-get update -y && sudo apt-get install -y openjdk-11-jdk && export JAVA_HOME=$(readlink -f /usr/bin/java | sed "s:/bin/java::") && echo "export JAVA_HOME=$JAVA_HOME" >> ~/.bashrc && source ~/.bashrc',
  },
  {
    id: 'R002',
    label: 'Python Not Found',
    pattern: /python.*not found|python3.*not found/i,
    description: 'Python3 is missing',
    fix: 'sudo apt-get install -y python3 python3-pip',
  },
  {
    id: 'R003',
    label: 'Scala Not Found',
    pattern: /scala.*not found|scala.*command not found/i,
    description: 'Scala is missing',
    fix: 'sudo apt-get install -y scala',
  },
  {
    id: 'R004',
    label: 'SSH Connection Failed',
    pattern: /ssh.*connection refused|ssh.*port 22|ssh.*timed out|no route to host/i,
    description: 'SSH not reachable',
    fix: 'sudo systemctl start ssh && sudo systemctl enable ssh',
  },
  {
    id: 'R005',
    label: 'Permission Denied',
    pattern: /permission denied|cannot write|access denied/i,
    description: 'File permission error on Spark directory',
    fix: 'sudo chown -R $USER:$USER /opt/spark && chmod -R 755 /opt/spark',
  },
  {
    id: 'R006',
    label: 'Disk Full',
    pattern: /no space left|disk full|out of space/i,
    description: 'Disk space exhausted',
    fix: 'sudo apt-get autoremove -y && sudo apt-get autoclean && sudo journalctl --vacuum-size=200M',
  },
  {
    id: 'R007',
    label: 'Network Unreachable',
    pattern: /network.*unreachable|cannot resolve|wget.*failed|temporary failure in name resolution/i,
    description: 'Network connectivity issue',
    fix: 'sudo systemctl restart NetworkManager 2>/dev/null || true && ping -c 2 8.8.8.8',
  },
  {
    id: 'R008',
    label: 'Spark Master Not Configured',
    pattern: /SPARK_MASTER.*not set|master.*not configured|Worker.*registration failed/i,
    description: 'Spark master host not set in spark-env.sh',
    fix: "echo \"export SPARK_MASTER_HOST=$(hostname -I | awk '{print $1}')\" >> $SPARK_HOME/conf/spark-env.sh && $SPARK_HOME/sbin/stop-all.sh 2>/dev/null; $SPARK_HOME/sbin/start-all.sh",
  },
  {
    id: 'R009',
    label: 'JVM Out of Memory',
    pattern: /heap.*space|OutOfMemoryError|java.*heap/i,
    description: 'JVM heap too small for Spark',
    fix: 'echo "export SPARK_EXECUTOR_MEMORY=2g" >> $SPARK_HOME/conf/spark-env.sh && echo "export SPARK_DRIVER_MEMORY=1g" >> $SPARK_HOME/conf/spark-env.sh',
  },
  {
    id: 'R010',
    label: 'Port Already In Use',
    pattern: /port.*already in use|address.*already in use|bind.*failed/i,
    description: 'Spark ports 7077 or 8080 already occupied',
    fix: 'sudo fuser -k 7077/tcp 8080/tcp 4040/tcp 2>/dev/null || true; sleep 2 && $SPARK_HOME/sbin/stop-all.sh 2>/dev/null; sleep 2 && $SPARK_HOME/sbin/start-all.sh',
  },
];

function applyRuleEngine(errorText) {
  for (const rule of RULES) {
    if (rule.pattern.test(errorText)) return rule;
  }
  return null;
}

module.exports = { RULES, applyRuleEngine };
