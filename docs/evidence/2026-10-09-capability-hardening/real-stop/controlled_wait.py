from pathlib import Path
import json, os, time
root=Path(__file__).resolve().parent
assert Path.cwd().resolve()==root
start={"pid":os.getpid(),"cwd":str(root),"startedUnix":time.time(),"marker":"FARFOLD_STOP_READY_20261010"}
(root/"started.json").write_text(json.dumps(start)+"\n")
print("FARFOLD_STOP_READY_20261010",os.getpid(),flush=True)
for i in range(45):
 time.sleep(1)
(root/"completed.txt").write_text("FARFOLD_STOP_FINISHED_20261010\n")
print("FARFOLD_STOP_FINISHED_20261010",flush=True)
