#!/usr/bin/env python3
"""Persistent daemon: holds QQ's log fd so Bugly never SIGPIPEs; auto-restarts."""
import subprocess, time, os, sys
QQ_ROOT = '/tmp/kqq/squashfs-root'
LOG = '/mnt/d/project/KatheryneQQ/runtime/qq.log'
while True:
    logf = open(LOG, 'ab')
    p = subprocess.Popen(
        ['./qq', '--no-sandbox', '--disable-gpu', '--headless'],
        cwd=QQ_ROOT, stdout=logf, stderr=logf, stdin=subprocess.DEVNULL,
        start_new_session=True, close_fds=True,
    )
    print(f"[daemon] spawned qq pid={p.pid}", flush=True)
    while p.poll() is None:
        time.sleep(5)
    logf.close()
    print(f"[daemon] qq exited rc={p.returncode}, respawn in 3s", flush=True)
    time.sleep(3)
