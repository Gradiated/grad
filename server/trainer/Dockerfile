# syntax=docker/dockerfile:1.7
#
# gpu: CUDA 13 runtime matching the PyPI torch 2.15 wheels (cu13); the default (last) stage.
# cpu: CPU-only torch for laptops and CI. It trains real models, slowly.
# Both run as the unprivileged user 10001.

FROM python:3.13.17-slim-trixie@sha256:d98cc29d3266e535dd9da1099688d9cb3ca4753813571e071763d17725460962 AS cpu
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/home/grad/.cache/huggingface \
    HF_HUB_DISABLE_PROGRESS_BARS=1
RUN useradd --create-home --uid 10001 grad \
    && install -d -o 10001 -g 10001 /home/grad/.cache/huggingface
WORKDIR /app
COPY requirements-cpu.lock ./
RUN pip install --no-cache-dir -r requirements-cpu.lock
COPY pyproject.toml README.md ./
COPY grad_trainer ./grad_trainer
RUN pip install --no-cache-dir --no-deps .
USER 10001:10001
CMD ["grad-trainer"]

FROM nvidia/cuda:13.4.3-runtime-ubuntu24.04@sha256:f58bd7a0701fae3a2160f22e1d451b77b349bd9ef83dad76f5529aa413c149a8 AS gpu
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    HF_HOME=/home/grad/.cache/huggingface \
    HF_HUB_DISABLE_PROGRESS_BARS=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv \
    && useradd --create-home --uid 10001 grad \
    && install -d -o 10001 -g 10001 /home/grad/.cache/huggingface
WORKDIR /app
COPY requirements-gpu.lock ./
RUN pip install --no-cache-dir -r requirements-gpu.lock
COPY pyproject.toml README.md ./
COPY grad_trainer ./grad_trainer
RUN pip install --no-cache-dir --no-deps .
USER 10001:10001
CMD ["grad-trainer"]
