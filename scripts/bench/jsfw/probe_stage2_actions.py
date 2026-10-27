#!/usr/bin/env python3
# coding: utf-8
"""STAGE-2 probe: drive JiuwenSwarm observable team actions in ISOLATION, no LLM.

Builds a minimal team (leader + 2 members) under an isolated OPENJIUWEN_HOME and
exercises the comparable interface directly:
  * team creation           -> TeamBackend.build_team
  * member creation         -> TeamBackend.spawn_member
  * DM                      -> TeamMessageManager.send_message
  * broadcast               -> TeamMessageManager.broadcast_message
  * task DAG + state flow   -> TeamTaskManager.add_graph / complete
  * review (verify gate)    -> reviewer-scoped TeamTaskManager.verify_task

No model call is made. No network / IM / cron / gateway.

Run:  /opt/openjiuwen/workswarm-venv/bin/python -u probe_stage2_actions.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
JSFW_HOME = HERE / ".jsfw-home"
os.environ["OPENJIUWEN_HOME"] = str(JSFW_HOME)
JSFW_HOME.mkdir(parents=True, exist_ok=True)

from openjiuwen.core.foundation.llm import ModelClientConfig, ModelRequestConfig
from openjiuwen.core.single_agent.schema.agent_card import AgentCard
from openjiuwen.agent_teams.schema.blueprint import LeaderSpec, TeamAgentSpec, TransportSpec
from openjiuwen.agent_teams.schema.deep_agent_spec import DeepAgentSpec, TeamModelConfig, WorkspaceSpec
from openjiuwen.agent_teams.schema.status import MemberStatus
from openjiuwen.agent_teams.schema.task import TaskGraphSpec
from openjiuwen.agent_teams.tools.task_manager import TeamTaskManager
from openjiuwen.agent_teams.context import set_session_id, get_session_id

FIXTURE_SID = "jsfw_fixture_sid"


def dummy_model(name):
    return TeamModelConfig(
        model_client_config=ModelClientConfig(client_provider="OpenAI", api_key="sk-x", api_base="http://127.0.0.1:9/v1"),
        model_request_config=ModelRequestConfig(model_name=name, temperature=0.0, max_tokens=64),
    )


def build_spec():
    ws = WorkspaceSpec(root_path=str(JSFW_HOME / "ws"), language="cn", stable_base=False)
    leader = DeepAgentSpec(
        model=dummy_model("dummy-leader"),
        system_prompt="fixture leader",
        tools=[], rails=[],
        enable_security_rail=False, enable_tool_resilience_rail=False,
        enable_task_loop=True, enable_sys_operation=False, auto_create_workspace=False,
        workspace=ws, cwd=str(JSFW_HOME), project_root=str(JSFW_HOME),
    )
    teammate = leader.model_copy(update={"model": dummy_model("dummy-teammate"), "system_prompt": "fixture teammate"})
    return TeamAgentSpec(
        agents={"leader": leader, "teammate": teammate},
        team_name="jsfw_fixture", lifecycle="temporary", teammate_mode="build_mode",
        spawn_mode="inprocess", enable_team_plan=False, evolution_enabled=False,
        leader=LeaderSpec(member_name="team_leader", display_name="Team Leader"),
        transport=TransportSpec(type="inprocess"),
    )


async def main() -> int:
    print("[stage2] building leader TeamAgent ...")
    agent = build_spec().build()
    tb = agent.team_backend
    tm = agent.task_manager
    mm = agent.message_manager
    # Bind a fixture session id so the per-session DYNAMIC tables (message/task
    # content) are materialized by db.initialize(). Without this the message
    # layer has no table to write to (observed: "no such table: team_message_*").
    set_session_id(FIXTURE_SID)
    await tb.db.initialize()
    await tb.db.create_cur_session_tables()
    print(f"[stage2] session_id={get_session_id()} backend={type(tb).__name__} task_mgr={type(tm).__name__} msg_mgr={type(mm).__name__}")

    # 1) team creation (+ leader registered as member)
    await tb.build_team(display_name="Fixture Team", desc="isolation fixture",
                        leader_display_name="Team Leader", leader_desc="leader of fixture")
    members0 = await tb.list_members()
    print(f"[stage2] build_team OK; roster={[m.member_name for m in members0]}")

    # 2) member creation (DB rows; no runtime spawn -> no session/loop needed)
    for name in ("worker_a", "reviewer_x"):
        r = await tb.spawn_member(
            member_name=name, display_name=name,
            agent_card=AgentCard(id=f"jsfw_fixture_{name}", name=name, description=name),
            status=MemberStatus.UNSTARTED,
        )
        print(f"[stage2] spawn_member({name}) ok={r.ok}")
    members = await tb.list_members()
    print(f"[stage2] roster now={[m.member_name for m in members]}")

    # 3) DM
    mid = await mm.send_message(content="hello worker_a", to_member_name="worker_a", from_member_name="team_leader")
    print(f"[stage2] DM message_id={mid}")

    # 4) broadcast
    bid = await mm.broadcast_message(content="team announcement", from_member_name="team_leader")
    print(f"[stage2] broadcast message_id={bid} unread={await mm.has_unread_messages()}")

    # 5) task DAG: t1 -> t2 (assigned to worker_a; leader cannot hold tasks, so a
    #    member-scoped task manager performs the author-side transitions).
    worker_tm = TeamTaskManager(team_name=tb.team_name, member_name="worker_a", db=tb.db,
                                messager=tb.messager, dispatch_mode="autonomous")
    g = await tm.add_graph([
        TaskGraphSpec(title="t1", content="first", task_id="t1", assignee="worker_a"),
        TaskGraphSpec(title="t2", content="second", task_id="t2", assignee="worker_a", depends_on=("t1",)),
    ])
    print(f"[stage2] add_graph ok={g.ok} reason={g.reason!r}")
    t1 = await tm.get("t1"); t2 = await tm.get("t2")
    print(f"[stage2] after add: t1={t1.status} t2={t2.status} (t2 should be blocked)")
    cl = await worker_tm.claim("t1")
    print(f"[stage2] worker_a.claim(t1) ok={cl.ok} -> {(await tm.get('t1')).status}")
    c = await worker_tm.complete("t1")
    print(f"[stage2] worker_a.complete(t1) ok={c.ok} reason={c.reason!r}")
    t2b = await tm.get("t2")
    print(f"[stage2] t2 after t1 completed = {t2b.status} (should be pending/unblocked)")

    # 6) review gate: t3 author=worker_a reviewer=reviewer_x; complete -> IN_REVIEW -> verify pass
    g3 = await tm.add_graph([TaskGraphSpec(
        title="t3", content="needs review", task_id="t3", assignee="worker_a",
        reviewer=({"type": "verifier", "reviewer_id": "reviewer_x", "instruction": "check"},),
    )])
    print(f"[stage2] add_graph(t3) ok={g3.ok}")
    cl3 = await worker_tm.claim("t3")
    print(f"[stage2] worker_a.claim(t3) ok={cl3.ok} -> {(await tm.get('t3')).status}")
    c3 = await worker_tm.complete("t3")
    t3 = await tm.get("t3")
    print(f"[stage2] worker_a.complete(t3) ok={c3.ok} -> status={t3.status} (should be in_review)")
    reviewer_tm = TeamTaskManager(team_name=tb.team_name, member_name="reviewer_x", db=tb.db,
                                  messager=tb.messager, dispatch_mode="autonomous")
    v = await reviewer_tm.verify_task("t3", "pass", feedback="looks good")
    t3b = await tm.get("t3")
    print(f"[stage2] verify_task(pass) ok={v.ok} reason={v.reason!r} -> t3={t3b.status} (should be completed)")

    print("[stage2] STAGE-2 OK: drove create-team/member/DM/broadcast/task-DAG/review with NO model call.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception:
        print("[stage2] FAILED:")
        traceback.print_exc()
        sys.exit(1)
