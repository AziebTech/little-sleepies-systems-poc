# Tooling image so the Python scripts run without a local Python install.
# The repo is bind-mounted at /repo by docker compose (service: tools).
FROM python:3.12-slim
WORKDIR /repo/python
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
CMD ["python", "-m", "pytest", "-q"]
