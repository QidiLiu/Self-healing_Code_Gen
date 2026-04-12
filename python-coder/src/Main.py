import subprocess
import os
import pathlib
import requests
import time
import json
import sys

# ================= CONFIGURATION =================
SERVER_CMD = r"C:\Users\ben\Lib\llama-b8757-bin-win-cuda-13.1-x64\llama-server.exe -m C:\Users\ben\Lib\llama-b8757-bin-win-cuda-13.1-x64\model\gemma-4-31B-it-Q6_K.gguf -c 16384"
PROJECT_ROOT = r"C:\Users\ben\Test\hello-world"
SRC_FOLDER = os.path.join(PROJECT_ROOT, "src")
MAIN_FILE = os.path.join(SRC_FOLDER, "Main.py")
API_URL = "http://localhost:8080/v1/chat/completions"

# The requirement for the code the LLM needs to write
USER_REQUIREMENT = "Write a Python program that calculates the first 10 numbers of the Fibonacci sequence and prints them."
# =================================================

def call_llama(prompt, system_prompt="You are a helpful coding assistant."):
    """Sends a request to the llama-server and returns the text response."""
    payload = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.2,
    }
    try:
        response = requests.post(API_URL, json=payload, timeout=3600)
        response.raise_for_status()
        return response.json()['choices'][0]['message']['content']
    except Exception as e:
        return f"Error communicating with server: {e}"

def clean_code(text):
    """Removes markdown code fences (```python ... ```) if present."""
    if "```python" in text:
        text = text.split("```python")[1].split("```")[0]
    elif "```" in text:
        text = text.split("```")[1].split("```")[0]
    return text.strip()

def run_python_code():
    """Runs the Main.py file and captures the output."""
    try:
        # Run the code using the current python interpreter
        result = subprocess.run(
            [sys.executable, MAIN_FILE], 
            capture_output=True, 
            text=True, 
            timeout=30
        )
        return result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return "", "Error: Execution timed out after 1 hour."
    except Exception as e:
        return "", str(e)

def main():
    # 1. Start llama-server
    print("[INFO] Starting llama-server...")
    server_process = subprocess.Popen(SERVER_CMD, shell=True)
    
    # Wait for server to boot up (adjust time based on your PC speed)
    time.sleep(15) 

    try:
        # 2 & 3. Create project structure
        print(f"[INFO] Creating project structure at {PROJECT_ROOT}...")
        os.makedirs(SRC_FOLDER, exist_ok=True)

        # Initial prompt to generate code
        current_prompt = f"{USER_REQUIREMENT}\n\nProvide only the raw Python code. Do not provide explanations."
        
        iteration = 0
        success = False

        while iteration < 64:
            iteration += 1
            print(f"\n[INFO] --- Iteration {iteration}/64 ---")

            # 4. Ask llama-server for code
            print("[INFO] Requesting code from LLM...")
            raw_response = call_llama(current_prompt)
            code = clean_code(raw_response)

            with open(MAIN_FILE, "w", encoding="utf-8") as f:
                f.write(code)
            print("[INFO] Code written to Main.py")

            # 5. Run the code and collect output
            print("[INFO] Executing code...")
            stdout, stderr = run_python_code()
            full_output = f"STDOUT:\n{stdout}\nSTDERR:\n{stderr}"
            
            print(f"[INFO] Execution Output:\n{full_output}")

            # Ask LLM if it works
            verify_prompt = (
                f"The requirement was: {USER_REQUIREMENT}\n"
                f"The code generated was:\n{code}\n"
                f"The execution output was:\n{full_output}\n\n"
                "Does this program work perfectly according to the requirements? "
                "Answer ONLY with 'YES' if it is correct, or provide the corrected code if it is wrong."
            )
            
            verification = call_llama(verify_prompt)
            
            if "YES" in verification.upper() and "```" not in verification:
                print("\n[INFO] Success! The LLM is satisfied with the result.")
                success = True
                break
            else:
                print("[INFO] Bugs detected or LLM not satisfied. Requesting correction...")
                # Prepare the prompt for the next iteration: feed back the error/output
                current_prompt = (
                    f"The previous code failed or was incorrect. \n"
                    f"Output received: {full_output}\n"
                    f"Please fix the code to meet this requirement: {USER_REQUIREMENT}\n"
                    "Provide only the raw Python code."
                )

        if not success:
            print("\n[INFO] Reached maximum iterations (64).")
            failure_reason = call_llama(f"You tried 64 times to solve: {USER_REQUIREMENT} and failed. Explain why.")
            print(f"[INFO] Reason for failure: {failure_reason}")

    finally:
        # Close the llama-server
        print("\n[INFO] Closing llama-server...")
        server_process.terminate()
        # On Windows, terminate() might not kill child processes of shell=True
        # This is a forceful fallback:
        subprocess.run("taskkill /F /IM llama-server.exe", shell=True, capture_output=True)
        print("[INFO] Done.")

if __name__ == "__main__":
    main()

