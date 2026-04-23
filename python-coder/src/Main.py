import sys
import time
import subprocess
import requests
import re
from pathlib import Path

# ================= CONFIGURATION =================
# Exact command string provided by user
SERVER_CMD_STR = (
    r"C:\Users\ben\Lib\llama-b8893-bin-win-cuda-13.1-x64\llama-server.exe "
    r"-m C:\Users\ben\Lib\llama-b8893-bin-win-cuda-13.1-x64\model\Qwen3.6-27B-UD-Q4_K_XL.gguf "
    r"-ngl 40 -c 65536"
)

PROJECT_ROOT = Path(r"C:\Users\ben\Test\hello-world")
SRC_DIR = PROJECT_ROOT / "src"
MAIN_PY = SRC_DIR / "Main.py"

PORT = 8080
API_URL = f"http://localhost:{PORT}/completion"  # Default llama.cpp server port
MAX_ATTEMPTS = 64
SERVER_STARTUP_TIMEOUT = 90  # Seconds (27B model needs time to load into VRAM)
CODE_EXEC_TIMEOUT = 15       # Seconds to prevent infinite loops in generated code

# Change this to your actual requirement
REQUIREMENT = "Write a Python script that prints 'Hello, World!' to the console and exits successfully."
# =================================================

def wait_for_server(url, timeout):
    """Poll the API until the server is ready."""
    start = time.time()
    print(f"   Waiting for server to load model & start API (up to {timeout}s)...")
    while time.time() - start < timeout:
        try:
            r = requests.get(url, timeout=2)
            if r.status_code == 200:
                return True
        except requests.exceptions.RequestException:
            pass
        time.sleep(3)
    return False

def query_llm(prompt, max_tokens=1024):
    """Send completion request to llama-server."""
    payload = {
        "prompt": prompt,
        "n_predict": max_tokens,
        "temperature": 0.1,
        "cache_prompt": True
    }
    try:
        resp = requests.post(API_URL, json=payload, timeout=3600)
        resp.raise_for_status()
        return resp.json().get("content", "").strip()
    except Exception as e:
        return f"API Error: {e}"

def extract_code(text):
    """Extract Python code from markdown blocks or raw text."""
    match = re.search(r"```(?:python)?\s*(.*?)\s*```", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text.strip()

def run_code():
    """Execute Main.py and capture stdout, stderr, and exit code."""
    try:
        result = subprocess.run(
            [sys.executable, str(MAIN_PY)],
            capture_output=True, text=True, timeout=CODE_EXEC_TIMEOUT,
            cwd=str(PROJECT_ROOT)
        )
        output = result.stdout + result.stderr
        return f"EXIT_CODE: {result.returncode}\nOUTPUT:\n{output}"
    except subprocess.TimeoutExpired:
        return "EXIT_CODE: TIMEOUT\nOUTPUT: Program execution timed out."
    except Exception as e:
        return f"EXIT_CODE: ERROR\nOUTPUT: {str(e)}"

def main():
    # 1. Create project structure
    print("1. Creating project structure...")
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    MAIN_PY.touch(exist_ok=True)
    print(f"   ✅ {PROJECT_ROOT}")
    print(f"   ✅ {SRC_DIR}")
    print(f"   ✅ {MAIN_PY}")

    # 2. Start llama-server
    print("\n2. Starting llama-server...")
    server_proc = subprocess.Popen(
        SERVER_CMD_STR,
        shell=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1
    )

    if not wait_for_server(f"http://localhost:{PORT}", SERVER_STARTUP_TIMEOUT):
        print("❌ Error: Server failed to start within timeout. Check CUDA drivers & VRAM.")
        subprocess.run("taskkill /F /IM llama-server.exe", shell=True, capture_output=True)
        server_proc.kill()
        sys.exit(1)
    print("   ✅ Server is ready and accepting requests.")

    success = False
    last_feedback = ""

    try:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            print(f"\n--- Attempt {attempt}/{MAX_ATTEMPTS} ---")

            # Build prompt based on attempt number
            if attempt == 1:
                prompt = f"Write a complete Python program for Main.py. Requirement: {REQUIREMENT}\nProvide ONLY the code inside a markdown python code block."
            else:
                prompt = f"Requirement: {REQUIREMENT}\nPrevious attempt failed. Execution output & feedback:\n{last_feedback}\nPlease fix the code. Provide ONLY the corrected code inside a markdown python code block."

            print("   🤖 Generating code...")
            llm_response = query_llm(prompt, max_tokens=1024)

            # Extract, validate, and save code
            code = extract_code(llm_response)
            if not code:
                print("   ⚠️ LLM returned empty code. Retrying...")
                continue

            with open(MAIN_PY, "w", encoding="utf-8") as f:
                f.write(code)
            print("   💾 Code saved to Main.py")

            # Run code
            print("   ▶️ Running code...")
            execution_output = run_code()
            print(f"   📤 Output: {execution_output[:150].replace(chr(10), ' ')}...")

            # Ask LLM to verify correctness
            verify_prompt = f"""Analyze the execution result of the Python program.
Execution Result:
{execution_output}
Requirement: {REQUIREMENT}

If the program met the requirement and ran successfully, respond EXACTLY with: ###SUCCESS###
If it failed, crashed, or didn't meet requirements, respond EXACTLY with: ###FAILED### followed by the reason.
"""
            print("   🔍 Checking correctness...")
            verify_resp = query_llm(verify_prompt, max_tokens=256)
            print(f"   📝 Verdict: {verify_resp.strip()}")

            if "###SUCCESS###" in verify_resp:
                success = True
                break
            else:
                # Prepare feedback for next iteration
                reason = verify_resp.replace("###FAILED###", "").strip()
                last_feedback = f"{execution_output}\nLLM Feedback: {reason}"

    finally:
        # 5. Cleanup: Close llama-server
        print("\n🛑 Shutting down llama-server...")
        server_proc.terminate()
        subprocess.run("taskkill /F /IM llama-server.exe", shell=True, capture_output=True)
        print("   ✅ Server stopped.")

    # Print final result
    if success:
        print("\n" + "="*50)
        print("✅ SUCCESS: Development completed successfully!")
        print(f"Final code saved to: {MAIN_PY}")
        print("="*50)
    else:
        print("\n" + "="*50)
        print(f"❌ FAILED: Could not satisfy requirements after {MAX_ATTEMPTS} attempts.")
        print(f"Reason: {verify_resp}")
        print("="*50)

if __name__ == "__main__":
    main()
