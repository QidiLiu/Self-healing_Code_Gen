# 🤖 Self-healing Code Generation: Local LLM-Assisted Code Generation & Debugging Loop

[![Python](https://img.shields.io/badge/Python-3.8%2B-blue.svg)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Local LLM](https://img.shields.io/badge/Runs%20Locally-Offline%20&%20Private-success)](https://github.com/ggml-org/llama.cpp)

A fully offline, automated development assistant that leverages local `llama-server` (llama.cpp) to iteratively generate, test, and debug Python code based on natural language requirements. Runs entirely on your machine with GPU acceleration.

---

## ✨ Features

- 🔒 **100% Offline & Private**: No cloud APIs, no data leaves your machine
- 🔄 **Iterative Self-Correction**: Automatically detects bugs, feeds execution output back to the LLM, and refines code up to 64 times
- 🐍 **Safe Execution**: Runs generated code in a sandboxed subprocess with configurable timeouts
- 🧠 **Smart Prompt Engineering**: Uses explicit success/failure tokens (`###SUCCESS###` / `###FAILED###`) for reliable parsing
- 🛠️ **Fully Configurable**: Adjust project paths, LLM command, temperature, timeouts, and requirements in one place
- 🧹 **Graceful Cleanup**: Automatically terminates the LLM server process on completion or failure

---

## 📦 Prerequisites

| Requirement | Details |
|-------------|---------|
| **Python** | `3.8` or higher |
| **llama.cpp** | Pre-compiled `llama-server.exe` (or `.bin` for Linux/macOS) |
| **GGUF Model** | Quantized model file (e.g., `Q4_K_M`, `Q5_K_S`) |
| **GPU (Recommended)** | NVIDIA CUDA 11.8+ / 12.x with sufficient VRAM (24GB+ for 27B models) |
| **Python Package** | `requests` |

```bash
pip install requests
```

---

## 🚀 Installation & Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/qidiliu/Self-healing_Code_Gen.git
   cd Self-healing_Code_Gen
   ```

2. **Install dependencies**
   ```bash
   pip install requests
   ```

3. **Configure the script**
   Open `Main.py` and update the configuration block at the top:
   ```python
   # Point to your llama-server executable & model
   SERVER_CMD_STR = r"C:\path\to\llama-server.exe -m C:\path\to\model.gguf -ngl 40 -c 65536"
   
   # Project & file paths
   PROJECT_ROOT = Path(r"C:\Users\ben\Test\hello-world")
   
   # Your actual task
   REQUIREMENT = "Write a Python script that prints 'Hello, World!' and exits successfully."
   ```

4. **Verify llama-server runs manually**
   ```bash
   C:\path\to\llama-server.exe -m C:\path\to\model.gguf -ngl 40 -c 65536
   ```
   Ensure it starts without CUDA/VRAM errors.

---

## 🎯 Usage

Run the automation loop:
```bash
python python-coder/src/Main.py
```

### What happens next?
1. ✅ Creates `hello-world/src/Main.py` structure
2. 🖥️ Spawns `llama-server` and waits for API readiness
3. 📝 Sends `REQUIREMENT` → receives generated code → saves to `Main.py`
4. ▶️ Executes code safely → captures stdout/stderr/exit code
5. 🔍 Asks LLM to verify correctness
6. 🔄 If failed: extracts feedback → loops back to step 3 (max 64 times)
7. 🏁 On success or limit reached: shuts down server & prints final report

---

## ⚙️ Configuration Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `SERVER_CMD_STR` | Full command to start llama-server | Windows CUDA example |
| `API_URL` | LLM API endpoint | `http://localhost:8080/completion` |
| `MAX_ATTEMPTS` | Maximum debugging iterations | `64` |
| `SERVER_STARTUP_TIMEOUT` | Seconds to wait for model loading | `90` |
| `CODE_EXEC_TIMEOUT` | Max runtime for generated code | `15` |
| `REQUIREMENT` | Natural language task description | `"Write a Python script..."` |

> 💡 **Tip**: Lower `temperature` (e.g., `0.1`) for deterministic code generation. Increase `n_predict` if your LLM truncates responses.

---

## 🔍 How It Works

```
[Start] → Create Project Structure → Launch llama-server → Wait for API
   ↓
[Loop ≤ 64] → Send Requirement → Generate Code → Save to Main.py
   ↓
Run Code → Capture Output → Send to LLM for Verification
   ↓
[Decision] → ###SUCCESS###? → ✅ Stop & Report → 🔚
              ↓
           ###FAILED###? → Extract Reason → Loop Back → 🔄
```

The script uses explicit parsing tokens to avoid regex ambiguity when interpreting LLM feedback, ensuring robust iteration even with conversational model outputs.

---

## ⚠️ Security & Safety Notice

- This tool **executes AI-generated Python code locally**. Always review generated code before production use.
- Execution is sandboxed via `subprocess` with a strict timeout to prevent infinite loops or resource exhaustion.
- Never point this at untrusted requirements or run it in privileged environments.
- For production-grade usage, consider running inside a Docker container or virtual machine.

---

## 🛠️ Troubleshooting

| Issue | Solution |
|-------|----------|
| `Server failed to start within timeout` | Check CUDA drivers, VRAM availability, and model path. Increase `SERVER_STARTUP_TIMEOUT`. |
| `Connection refused to localhost:8080` | Ensure no firewall blocks port 8080. Verify llama-server is running. |
| `Program execution timed out` | Increase `CODE_EXEC_TIMEOUT` or check for infinite loops in generated code. |
| LLM returns conversational text instead of code | Ensure `temperature` is low (`0.0–0.2`). The prompt enforces markdown code blocks. |
| Permission denied on folder creation | Run terminal as Administrator or change `PROJECT_ROOT` to a writable directory. |

---

## 📜 License

This project is licensed under the **MIT License**. See [LICENSE](https://github.com/QidiLiu/Self-healing_Code_Gen/blob/main/LICENSE) for details.

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Ideas for Enhancement
- [ ] Multi-file project generation
- [ ] Unit test integration (pytest)
- [ ] Web UI dashboard for monitoring iterations

---

## 🙏 Acknowledgements

- [llama.cpp](https://github.com/ggml-org/llama.cpp) – Fast inference engine for running LLMs locally
- [GGUF format](https://github.com/ggerganov/ggml/blob/master/docs/gguf.md) – Standardized model serialization
- Open-source quantized models (Qwen, Llama, Mistral, etc.)

---

*Built for developers who want AI-assisted coding without leaving their machine.* 🖥️🔒