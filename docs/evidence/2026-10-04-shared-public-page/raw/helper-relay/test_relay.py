#!/usr/bin/env python3
"""Controlled JSON-lines helper checks; own socket/process/pipes only.

Run only after the new helper-runner has been compiled:
  python3 test_relay.py --runner ./helper-runner

No Agent, Tauri, browser, account, existing environment, or user data is used.
Results contain test names and fixed diagnostic codes, never protocol bodies,
capabilities, stdout contents, or exception tracebacks.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import tempfile
import termios
import time
from typing import Any, Callable


ROOT = Path(__file__).resolve().parent
MODE = "--farfold-browser-mcp-helper"
CAPABILITY_ENV = "FARFOLD_BROWSER_CAPABILITY"
SYNTHETIC_CAPABILITY = "c" * 64
INPUT_LIMIT = 65_536
BROKER_LIMIT = 1_300_000
STDOUT_LIMIT = 600_000
IO_TIMEOUT = 2.5
STOP_TIMEOUT = 0.75
LARGE_TEXT_LENGTH = 550_000


class CheckFailure(Exception):
    """Only fixed codes, never a message containing a packet or capability."""


def check(condition: bool, code: str) -> None:
    if not condition:
        raise CheckFailure(code)


def encoded(message: dict[str, Any]) -> bytes:
    return json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"


def pending_bytes(fd: int) -> int:
    return struct.unpack("I", fcntl.ioctl(fd, termios.FIONREAD, struct.pack("I", 0)))[0]


def wait_until(predicate: Callable[[], bool], code: str, timeout: float = IO_TIMEOUT) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        # Short bounded scheduling interval; no busy wait or external activity.
        time.sleep(0.005)
    raise CheckFailure(code)


def request(number: int, padding: int = 0) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0", "id": number, "method": "tools/call",
        "params": {"name": "synthetic_read", "arguments": {"padding": "q" * padding}},
    }


def response(number: int, length: int = 20) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0", "id": number,
        "result": {"content": [{"type": "text", "text": "p" * length}], "isError": False},
    }


class Relay:
    def __init__(self, runner: Path, small_control_buffer: bool = False):
        self.temp = tempfile.TemporaryDirectory(prefix="ff-relay-", dir="/tmp")
        os.chmod(self.temp.name, 0o700)
        self.path = str(Path(self.temp.name) / "relay.sock")
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.connection: socket.socket | None = None
        self.process: subprocess.Popen[bytes] | None = None
        self.input_witness_fd: int | None = None
        self.control_buffer = bytearray()
        self.output_buffer = bytearray()
        self.control_eof = False
        self.output_eof = False
        try:
            if small_control_buffer:
                # Above Darwin's socket write low-water mark, still far below
                # the 65 KiB synthetic request used to force partial writes.
                self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            self.listener.bind(self.path)
            os.chmod(self.path, 0o600)
            check(Path(self.temp.name).stat().st_mode & 0o777 == 0o700, "directory_not_private")
            check(Path(self.path).stat().st_mode & 0o777 == 0o600, "socket_not_private")
            self.listener.listen(1)
            self.listener.settimeout(IO_TIMEOUT)
            # Keep our own read-end witness: Darwin FIONREAD on a pipe's
            # write end reports zero and cannot prove whether stdin was read.
            input_read, input_write = os.pipe()
            self.input_witness_fd = input_read
            self.process = subprocess.Popen(
                [str(runner), MODE, self.path],
                stdin=input_read, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                # Deliberately do not inspect or inherit the real environment.
                env={CAPABILITY_ENV: SYNTHETIC_CAPABILITY}, bufsize=0,
            )
            self.process.stdin = os.fdopen(input_write, "wb", buffering=0)
            self.connection, _ = self.listener.accept()
            if small_control_buffer:
                self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            self.connection.setblocking(False)
            assert self.process.stdin is not None
            assert self.process.stdout is not None
            assert self.process.stderr is not None
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                os.set_blocking(stream.fileno(), False)
            hello = self.control_frame()
            check(hello == {"kind": "hello", "capability": SYNTHETIC_CAPABILITY}, "hello_mismatch")
            self.send_control({"kind": "hello_ack"})
        except BaseException:
            self.close()
            raise

    def __enter__(self) -> "Relay":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    @property
    def input_fd(self) -> int:
        assert self.process is not None and self.process.stdin is not None
        return self.process.stdin.fileno()

    @property
    def output_fd(self) -> int:
        assert self.process is not None and self.process.stdout is not None
        return self.process.stdout.fileno()

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()
        self.listener.close()
        if self.process is not None:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=IO_TIMEOUT)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
        if self.input_witness_fd is not None:
            os.close(self.input_witness_fd)
            self.input_witness_fd = None
        self.temp.cleanup()

    def send_bytes(self, fd: int, data: bytes, timeout: float = IO_TIMEOUT) -> None:
        remaining = memoryview(data)
        deadline = time.monotonic() + timeout
        while remaining:
            left = deadline - time.monotonic()
            check(left > 0, "write_timeout")
            if not select.select([], [fd], [], left)[1]:
                raise CheckFailure("write_timeout")
            try:
                count = os.write(fd, remaining)
            except BlockingIOError:
                continue
            check(count > 0, "write_zero")
            remaining = remaining[count:]

    def send_control(self, *messages: dict[str, Any]) -> None:
        assert self.connection is not None
        lines = [encoded(message) for message in messages]
        check(all(len(line) <= BROKER_LIMIT for line in lines), "fixture_broker_limit")
        # One write buffer permits deterministic response+stop batching.
        self.send_bytes(self.connection.fileno(), b"".join(lines))

    def send_requests(self, *messages: dict[str, Any]) -> None:
        lines = [encoded(message) for message in messages]
        check(all(len(line) <= INPUT_LIMIT for line in lines), "fixture_input_limit")
        self.send_bytes(self.input_fd, b"".join(lines))

    def control_frame(self, timeout: float = IO_TIMEOUT) -> dict[str, Any]:
        assert self.connection is not None
        deadline = time.monotonic() + timeout
        while b"\n" not in self.control_buffer:
            check(not self.control_eof, "unexpected_control_eof")
            left = deadline - time.monotonic()
            check(left > 0, "control_frame_timeout")
            if not select.select([self.connection], [], [], left)[0]:
                raise CheckFailure("control_frame_timeout")
            try:
                chunk = self.connection.recv(65_536)
            except BlockingIOError:
                continue
            if not chunk:
                self.control_eof = True
                continue
            self.control_buffer.extend(chunk)
            check(len(self.control_buffer) <= BROKER_LIMIT * 2, "control_buffer_overflow")
        line, _, rest = self.control_buffer.partition(b"\n")
        self.control_buffer[:] = rest
        try:
            value = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise CheckFailure("malformed_control_frame") from None
        check(isinstance(value, dict), "control_frame_not_object")
        return value

    def expect_request(self, message: dict[str, Any]) -> None:
        frame = self.control_frame()
        check(frame == {"kind": "request", "message": message}, "request_mismatch_or_order")

    def expect_written(self, delivery: int) -> None:
        check(self.control_frame() == {"kind": "written", "delivery": delivery}, "written_mismatch")

    def expect_stopped(self, barrier: int, closed: bool, timeout: float = STOP_TIMEOUT) -> None:
        check(
            self.control_frame(timeout) == {"kind": "stopped", "barrier": barrier, "stdoutClosed": closed},
            "stopped_mismatch_or_order",
        )

    def output_line(self, timeout: float = IO_TIMEOUT) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while b"\n" not in self.output_buffer:
            check(not self.output_eof, "unexpected_stdout_eof")
            left = deadline - time.monotonic()
            check(left > 0, "stdout_line_timeout")
            if not select.select([self.output_fd], [], [], left)[0]:
                raise CheckFailure("stdout_line_timeout")
            chunk = os.read(self.output_fd, 65_536)
            if not chunk:
                self.output_eof = True
            else:
                self.output_buffer.extend(chunk)
                check(len(self.output_buffer) <= STDOUT_LIMIT + 1, "stdout_buffer_overflow")
        line, _, rest = self.output_buffer.partition(b"\n")
        self.output_buffer[:] = rest
        try:
            value = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise CheckFailure("malformed_stdout_frame") from None
        check(isinstance(value, dict), "stdout_frame_not_object")
        return value

    def output_to_eof(self, timeout: float = IO_TIMEOUT) -> bytes:
        data = bytearray(self.output_buffer)
        self.output_buffer.clear()
        deadline = time.monotonic() + timeout
        while not self.output_eof:
            left = deadline - time.monotonic()
            check(left > 0, "stdout_eof_timeout")
            if not select.select([self.output_fd], [], [], left)[0]:
                raise CheckFailure("stdout_eof_timeout")
            chunk = os.read(self.output_fd, 65_536)
            if not chunk:
                self.output_eof = True
            else:
                data.extend(chunk)
                check(len(data) <= STDOUT_LIMIT, "stdout_exceeded_fixture_bound")
        return bytes(data)

    def expect_exit(self, allowed: tuple[int, ...] = (0,)) -> None:
        assert self.process is not None and self.process.stderr is not None
        code = self.process.wait(timeout=IO_TIMEOUT)
        check(code in allowed, "unexpected_exit_status")
        check(self.process.stderr.read() == b"", "stderr_not_silent")

    def stop_cleanly(self, barrier: int = 999) -> None:
        self.send_control({"kind": "stop", "barrier": barrier, "close": True})
        self.expect_stopped(barrier, True)
        check(self.output_to_eof() == b"", "close_produced_unexpected_stdout")
        self.expect_exit()


def normal_written_and_two_requests(runner: Path) -> None:
    with Relay(runner) as relay:
        first, second = request(1), request(2)
        relay.send_requests(first, second)
        for message, delivery in ((first, 11), (second, 12)):
            relay.expect_request(message)
            body = response(message["id"])
            relay.send_control({"kind": "response", "delivery": delivery, "page": True, "message": body})
            relay.expect_written(delivery)
            # Receiving written means an entire JSON line is already readable.
            check(pending_bytes(relay.output_fd) > 0, "written_preceded_stdout")
            check(relay.output_line() == body, "normal_stdout_mismatch")
        relay.stop_cleanly()


def stop_discards_unwritten_page_before_replacement(runner: Path) -> None:
    with Relay(runner) as relay:
        message = request(3)
        relay.send_requests(message)
        relay.expect_request(message)
        body = response(3, 257)
        relay.send_control(
            {"kind": "response", "delivery": 13, "page": True, "message": body},
            {"kind": "stop", "barrier": 23, "close": False},
        )
        relay.expect_stopped(23, False)
        relay.expect_written(13)
        result = relay.output_line()
        check(result.get("jsonrpc") == "2.0" and result.get("id") == 3, "replacement_id_changed")
        check(isinstance(result.get("result"), dict), "replacement_not_mcp_result")
        check(result["result"].get("isError") is True, "replacement_not_error")
        check("p" * 257 not in json.dumps(result), "replacement_contains_stale_body")
        relay.stop_cleanly()


def stop_preserves_unwritten_nonpage(runner: Path) -> None:
    with Relay(runner) as relay:
        message = request(4)
        relay.send_requests(message)
        relay.expect_request(message)
        body = response(4)
        relay.send_control(
            {"kind": "response", "delivery": 14, "page": False, "message": body},
            {"kind": "stop", "barrier": 24, "close": False},
        )
        relay.expect_stopped(24, False)
        relay.expect_written(14)
        check(relay.output_line() == body, "nonpage_was_discarded")
        relay.stop_cleanly()


def partial_stop(runner: Path, explicit_close: bool) -> None:
    with Relay(runner) as relay:
        message = request(5)
        relay.send_requests(message)
        relay.expect_request(message)
        body = response(5, LARGE_TEXT_LENGTH)
        relay.send_control({"kind": "response", "delivery": 15, "page": True, "message": body})
        wait_until(lambda: pending_bytes(relay.output_fd) > 0, "no_partial_stdout")
        before = pending_bytes(relay.output_fd)
        check(0 < before < len(encoded(body)), "fixture_not_partial")
        relay.send_control({"kind": "stop", "barrier": 25, "close": explicit_close})
        relay.expect_stopped(25, True)
        frozen = pending_bytes(relay.output_fd)
        output = relay.output_to_eof()
        # Pipe bytes written before ACK remain readable. ACK must freeze that
        # quantity; no later body or replacement bytes may appear after draining.
        check(len(output) == frozen, "body_advanced_after_stopped")
        check(0 < len(output) < len(encoded(body)) and b"\n" not in output, "partial_body_not_cut_off")
        relay.expect_exit()


def partial_page_stop_closes_stdout(runner: Path) -> None:
    partial_stop(runner, False)


def explicit_close_cuts_off_partial_stdout(runner: Path) -> None:
    partial_stop(runner, True)


def close_ack_then_exit(runner: Path) -> None:
    with Relay(runner) as relay:
        relay.stop_cleanly(26)


def broker_eof_closes_stdout(runner: Path) -> None:
    with Relay(runner) as relay:
        assert relay.connection is not None
        relay.connection.shutdown(socket.SHUT_RDWR)
        relay.connection.close()
        check(relay.output_to_eof() == b"", "broker_eof_produced_stdout")
        # An EOF can be represented as clean disconnect or protocol failure;
        # either must close promptly and silently, never leave a worker alive.
        relay.expect_exit((0, 1))


def stdin_eof_closes_connection(runner: Path) -> None:
    with Relay(runner) as relay:
        assert relay.process is not None and relay.process.stdin is not None
        relay.process.stdin.close()
        check(relay.output_to_eof() == b"", "stdin_eof_produced_stdout")
        relay.expect_exit((0, 1))
        assert relay.connection is not None
        check(select.select([relay.connection], [], [], IO_TIMEOUT)[0] != [], "stdin_eof_left_control_open")
        check(relay.connection.recv(1) == b"", "stdin_eof_left_control_data")


def stdout_blocked_reports_failed_at_deadline(runner: Path) -> None:
    with Relay(runner) as relay:
        message = request(8)
        relay.send_requests(message)
        relay.expect_request(message)
        body = response(8, LARGE_TEXT_LENGTH)
        started = time.monotonic()
        relay.send_control({"kind": "response", "delivery": 18, "page": True, "message": body})
        wait_until(lambda: pending_bytes(relay.output_fd) > 0, "blocked_stdout_never_started")
        check(pending_bytes(relay.output_fd) < len(encoded(body)), "blocked_stdout_fixture_did_not_block")
        check(relay.control_frame(1.8) == {"kind": "failed"}, "blocked_stdout_missing_failed")
        elapsed = time.monotonic() - started
        check(0.8 <= elapsed <= 1.8, "stdout_write_deadline_outside_tolerance")
        frozen = pending_bytes(relay.output_fd)
        check(len(relay.output_to_eof()) == frozen, "failed_output_kept_advancing")
        relay.expect_exit((1,))


def uds_backpressure_does_not_block_stop(runner: Path) -> None:
    with Relay(runner, small_control_buffer=True) as relay:
        message = request(9, 65_000)
        relay.send_requests(message)
        assert relay.connection is not None
        wait_until(lambda: pending_bytes(relay.connection.fileno()) > 0, "no_backpressured_request")
        # Do not drain the broker receive side. An incomplete JSON line proves
        # that the helper has an outgoing request blocked part way through.
        time.sleep(0.05)
        peek = relay.connection.recv(INPUT_LIMIT + 1024, socket.MSG_PEEK)
        check(peek and b"\n" not in peek, "fixture_did_not_force_uds_backpressure")
        started = time.monotonic()
        relay.send_control({"kind": "stop", "barrier": 29, "close": True})
        # A stopped ACK cannot overtake a partially written request frame on
        # the same stream. stdout closure independently proves stop processing
        # while that output is blocked; only then do we drain for the ACK.
        check(relay.output_to_eof(STOP_TIMEOUT) == b"", "backpressured_stop_produced_stdout")
        check(time.monotonic() - started < STOP_TIMEOUT, "stop_waited_for_uds_output")
        relay.expect_request(message)
        relay.expect_stopped(29, True)
        relay.expect_exit()


def stop_closes_when_second_request_is_already_buffered(runner: Path) -> None:
    with Relay(runner) as relay:
        first, second = request(30), request(31)
        batch = encoded(first) + encoded(second)
        # Both complete requests fit one atomic pipe write and one helper read.
        # Seeing request 1 therefore establishes that request 2 was observed
        # but cannot yet be forwarded while request 1 remains in flight.
        check(len(batch) <= os.fpathconf(relay.input_fd, "PC_PIPE_BUF"), "fixture_batch_not_atomic")
        check(len(batch) <= 8192, "fixture_batch_exceeds_helper_read")
        relay.send_requests(first, second)
        relay.expect_request(first)
        relay.send_control({"kind": "stop", "barrier": 30, "close": False})
        relay.expect_stopped(30, True)
        check(relay.output_to_eof() == b"", "buffered_request_stop_produced_stdout")
        relay.expect_exit()
        # No old second request may be forwarded after the close ACK.
        assert relay.connection is not None
        check(not relay.control_buffer, "buffered_request_followed_stop_ack")
        check(select.select([relay.connection], [], [], IO_TIMEOUT)[0] != [], "buffered_stop_control_not_closed")
        check(relay.connection.recv(1) == b"", "buffered_request_forwarded_after_stop")


def nonclose_stop_preserves_fifo_and_pauses_stdin_until_ack(runner: Path) -> None:
    with Relay(runner, small_control_buffer=True) as relay:
        first, second = request(32, 65_000), request(33)
        relay.send_requests(first)
        assert relay.connection is not None and relay.process is not None
        wait_until(lambda: pending_bytes(relay.connection.fileno()) > 0, "no_nonclose_backpressured_request")
        time.sleep(0.05)
        peek = relay.connection.recv(INPUT_LIMIT + 1024, socket.MSG_PEEK)
        check(peek and b"\n" not in peek, "nonclose_fixture_not_backpressured")
        relay.send_control({"kind": "stop", "barrier": 32, "close": False})
        # Keep the outgoing request blocked, so stopped cannot finish writing.
        # After several worker poll intervals, new stdin bytes must remain in
        # the pipe, unobserved by the worker until the barrier ACK fully drains.
        time.sleep(0.15)
        relay.send_requests(second)
        time.sleep(0.15)
        check(relay.process.poll() is None, "nonclose_stop_exited_early")
        assert relay.input_witness_fd is not None
        check(pending_bytes(relay.input_witness_fd) == len(encoded(second)), "stdin_read_before_stopped_fully_written")
        check(select.select([relay.output_fd], [], [], 0)[0] == [], "nonclose_stop_closed_or_wrote_stdout")
        # Already queued request bytes retain FIFO order; stopped cannot split
        # or overtake them. Draining the ACK then permits normal stdin progress.
        relay.expect_request(first)
        relay.expect_stopped(32, False)
        for message, delivery in ((first, 32), (second, 33)):
            if message is second:
                relay.expect_request(second)
            body = response(message["id"])
            relay.send_control({"kind": "response", "delivery": delivery, "page": False, "message": body})
            relay.expect_written(delivery)
            check(relay.output_line() == body, "post_barrier_response_mismatch")
        relay.stop_cleanly()


TESTS: tuple[Callable[[Path], None], ...] = (
    normal_written_and_two_requests,
    stop_discards_unwritten_page_before_replacement,
    stop_preserves_unwritten_nonpage,
    partial_page_stop_closes_stdout,
    explicit_close_cuts_off_partial_stdout,
    close_ack_then_exit,
    broker_eof_closes_stdout,
    stdin_eof_closes_connection,
    stdout_blocked_reports_failed_at_deadline,
    uds_backpressure_does_not_block_stop,
    stop_closes_when_second_request_is_already_buffered,
    nonclose_stop_preserves_fifo_and_pauses_stdin_until_ack,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner", type=Path, default=ROOT / "helper-runner")
    parser.add_argument("--only", choices=[test.__name__ for test in TESTS], action="append")
    args = parser.parse_args()
    runner = args.runner.resolve()
    if not runner.is_file() or not os.access(runner, os.X_OK):
        print(json.dumps({"passed": False, "testsRun": 0, "reason": "runner_missing_or_not_executable"}))
        return 2
    results = []
    for test in TESTS:
        if args.only and test.__name__ not in args.only:
            continue
        started = time.monotonic()
        try:
            test(runner)
            row = {"name": test.__name__, "passed": True}
        except CheckFailure as error:
            row = {"name": test.__name__, "passed": False, "reason": str(error)}
        except BaseException as error:
            # Exception text/tracebacks can include packet contents; suppress.
            row = {"name": test.__name__, "passed": False, "reason": type(error).__name__}
        row["durationSeconds"] = round(time.monotonic() - started, 3)
        results.append(row)
    report = {
        "passed": all(row["passed"] for row in results),
        "testsRun": len(results),
        "passedCount": sum(row["passed"] for row in results),
        "scope": "own private temporary Unix socket and synthetic helper stdio pipes only",
        "tests": results,
    }
    formatted = json.dumps(report, indent=2) + "\n"
    (ROOT / "relay-results.json").write_text(formatted)
    (ROOT / "relay-tests.log").write_text(formatted)
    print(formatted, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
