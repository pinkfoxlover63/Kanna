"""Build the CUDA-GPU Piper server exe.

Run: py -3 scripts\\piper_cuda_pyinstaller.py

Collects piper + onnxruntime as usual, and additionally injects every NVIDIA
CUDA/cuDNN wheel DLL (cudart, cublas, cuDNN...) found in the .opencode/cuda-venv
site-packages into the bundle under its `nvidia/...` path. piper_server.py's
_add_cuda_dll_dirs() finds that tree next to sys._MEIPASS and preloads the
DLLs at runtime, which is what lets onnxruntime_providers_cuda.dll link up.
"""
import glob
import os
import subprocess
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cuda_venv_sp = os.path.join(root, ".opencode", "cuda-venv", "Lib", "site-packages")

dlls = sorted(glob.glob(os.path.join(cuda_venv_sp, "nvidia", "**", "*.dll"), recursive=True))
if not dlls:
    sys.exit(f"no nvidia DLLs under {cuda_venv_sp} — first run: "
             f"{os.path.join(cuda_venv_sp, '..', '..', 'Scripts', 'python.exe')} -m pip install --no-deps "
             "nvidia-cuda-runtime nvidia-cublas nvidia-cudnn-cu13")
print(f"bundling {len(dlls)} NVIDIA DLLs", flush=True)

cmd = [
    sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile",
    "--name", "kanna-piper-server-cuda",
    "--distpath", os.path.join(root, ".opencode", "cuda"),
    "--workpath", os.path.join(root, ".opencode", "cuda-build"),
    "--specpath", os.path.join(root, ".opencode", "cuda-build"),
    "--collect-all", "piper",
    "--collect-all", "onnxruntime",
]
for dll in dlls:
    dest = os.path.relpath(os.path.dirname(dll), cuda_venv_sp)
    cmd += ["--add-binary", dll + ";" + dest]
cmd += [os.path.join(root, "resources", "piper", "piper_server.py")]

raise SystemExit(subprocess.call(cmd))
