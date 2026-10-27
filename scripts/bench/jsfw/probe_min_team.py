#!/usr/bin/env python3
# coding: utf-8
"""Feasibility probe: build a minimal JiuwenSwarm team in an ISOLATED home.

Runs against the installed framework core only (openjiuwen 0.1.19). No network,
no IM, no cron, no gateway. Everything under JSFW_HOME (project-local).

Stage 1 = construct + configure leader TeamAgent (no LLM round).
Stage 2 = drive observable framework actions directly (create member / DM /
          broadcast / task DAG / review) WITHOUT a model call.

Run:  /opt/openjiuwen/workswarm-venv/bin/python probe_min_team.py
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Isolated runtime home for openjiuwen agent-team state (DB, workspaces).
JSFW_HOME = HERE / ".jsfw-home"
os.environ["OPENJIUWEN_HOME"] = str(JSFW_HOME)
JSFW_HOME.mkdir(parents=True, exist_ok=True)
print(f"[probe] OPENJIUWEN_HOME={JSFW_HOME}")

try:
    from openjiuwen.agent_teams.paths import get_openjiuwen_home, get_agent_teams_home
    print(f"[probe] resolved openjiuwen_home = {get_openjiuwen_home()}")
    print(f"[probe] resolved agent_teams_home = {get_agent_teams_home()}")
except Exception:
    traceback.print_exc()
    sys.exit(2)

from openjiuwen.core.foundation.llm import ModelClientConfig, ModelRequestConfig
from openjiuwen.agent_teams.schema.blueprint import (
    LeaderSpec, TeamAgentSpec, TransportSpec, StorageSpec,
)
from openjiuwen.agent_teams.schema.deep_agent_spec import (
    DeepAgentSpec, TeamModelConfig, WorkspaceSpec,
)


def dummy_model(name="dummy-model") -> TeamModelConfig:
    return TeamModelConfig(
        model_client_config=ModelClientConfig(
            client_provider="OpenAI",
            api_key="sk-not-used",
            api_base="http://127.0.0.1:9/v1",
        ),
        model_request_config=ModelRequestConfig(model_name=name, temperature=0.0, max_tokens=64),
    )


def build_spec() -> TeamAgentSpec:
    member_ws = WorkspaceSpec(root_path=str(JSFW_HOME / "ws"), language="cn", stable_base=False)
    leader = DeepAgentSpec(
        model=dummy_model("dummy-leader"),
        system_prompt="You are the team leader (fixture). Do nothing but tool calls when asked.",
        tools=[],
        rails=[],
        enable_security_rail=False,
        enable_tool_resilience_rail=False,
        enable_task_loop=True,
        enable_sys_operation=False,
        auto_create_workspace=False,
        workspace=member_ws,
        cwd=str(JSFW_HOME),
        project_root=str(JSFW_HOME),
    )
    teammate = leader.model_copy(update={
        "model": dummy_model("dummy-teammate"),
        "system_prompt": "You are a teammate (fixture).",
    })
    spec = TeamAgentSpec(
        agents={"leader": leader, "teammate": teammate},
        team_name="jsfw_fixture",
        lifecycle="temporary",
        teammate_mode="build_mode",
        spawn_mode="inprocess",              # co-located, in-process messager
        enable_team_plan=False,
        evolution_enabled=False,
        member_workspace_prefix=True,
        leader=LeaderSpec(member_name="team_leader", display_name="Team Leader"),
        transport=TransportSpec(type="inprocess"),   # no external service
    )
    return spec


def main() -> int:
    print("[probe] building spec ...")
    spec = build_spec()
    print(f"[probe] spec.spawn_mode={spec.spawn_mode} storage={spec.storage}")
    dbcfg = spec.resolve_db_config()
    print(f"[probe] resolve_db_config -> {dbcfg.db_type} :: {dbcfg.connection_string}")

    print("[probe] spec.build() (configure leader TeamAgent, no round) ...")
    agent = spec.build()
    print(f"[probe] leader agent = {type(agent).__name__} role={agent.role} member={agent.member_name}")
    tb = agent.team_backend
    print(f"[probe] team_backend = {type(tb).__name__ if tb else None} team_name={getattr(tb,'team_name',None)}")
    print(f"[probe] task_manager   = {type(agent.task_manager).__name__ if agent.task_manager else None}")
    print(f"[probe] message_manager= {type(agent.message_manager).__name__ if agent.message_manager else None}")
    print(f"[probe] harness        = {type(agent.harness).__name__ if agent.harness else None}")
    print("[probe] STAGE-1 OK: built+configured a minimal leader TeamAgent with no network/service.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("[probe] FAILED with traceback:")
        traceback.print_exc()
        sys.exit(1)
