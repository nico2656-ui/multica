package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/service"
)

func registerEventAutopilotListeners(
	bus *events.Bus,
	pool *pgxpool.Pool,
	queries *db.Queries,
	svc *service.AutopilotService,
) {
	handler := func(e events.Event) {
		go dispatchMatchingEventTriggers(context.Background(), pool, queries, svc, e)
	}

	bus.Subscribe(protocol.EventIssueLabelsChanged, handler)
	bus.Subscribe(protocol.EventIssueUpdated, handler)
	bus.Subscribe(protocol.EventTaskCompleted, handler)
	bus.Subscribe(protocol.EventTaskFailed, handler)
	bus.Subscribe(protocol.EventTaskCancelled, handler)
	bus.Subscribe(protocol.EventAutopilotRunDone, handler)
}

type eventTrigger struct {
	ID          string
	AutopilotID string
	Conditions  []byte
}

func dispatchMatchingEventTriggers(
	ctx context.Context,
	pool *pgxpool.Pool,
	queries *db.Queries,
	svc *service.AutopilotService,
	e events.Event,
) {
	rows, err := pool.Query(ctx,
		`SELECT t.id, t.autopilot_id, t.conditions
		 FROM autopilot_trigger t
		 JOIN autopilot a ON a.id = t.autopilot_id
		 WHERE t.kind = 'event'
		   AND t.enabled = true
		   AND t.event_name = $1
		   AND a.status = 'active'`, e.Type)
	if err != nil {
		return
	}
	defer rows.Close()

	var triggers []eventTrigger
	for rows.Next() {
		var t eventTrigger
		if err := rows.Scan(&t.ID, &t.AutopilotID, &t.Conditions); err != nil {
			continue
		}
		triggers = append(triggers, t)
	}

	for _, t := range triggers {
		if !conditionsMatch(t.Conditions, e) {
			continue
		}
		var apID pgtype.UUID
		if err := apID.Scan(t.AutopilotID); err != nil {
			continue
		}
		var trigID pgtype.UUID
		trigID.Scan(t.ID)

		autopilot, err := queries.GetAutopilot(ctx, apID)
		if err != nil {
			continue
		}
		payload, _ := json.Marshal(e)
		_, _ = svc.DispatchAutopilot(ctx, autopilot, trigID, "event", payload)
	}
}

func conditionsMatch(conditionsBytes []byte, e events.Event) bool {
	if len(conditionsBytes) == 0 {
		return true
	}
	var conditions map[string]interface{}
	if err := json.Unmarshal(conditionsBytes, &conditions); err != nil {
		return false
	}

	payload, ok := e.Payload.(map[string]interface{})
	if !ok {
		return len(conditions) == 0
	}

	for key, expected := range conditions {
		actual, exists := payload[key]
		if !exists {
			return false
		}
		if fmt.Sprint(expected) != fmt.Sprint(actual) {
			return false
		}
	}
	return true
}
