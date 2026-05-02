package main

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/logger"
)

//go:embed all:migrations
var migrationFS embed.FS

func main() {
	logger.Init()

	if len(os.Args) < 2 {
		fmt.Println("Usage: migrate-embed <up|down>")
		os.Exit(1)
	}

	direction := os.Args[1]
	if direction != "up" && direction != "down" {
		fmt.Println("Usage: migrate-embed <up|down>")
		os.Exit(1)
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://multica:multica@localhost:5432/multica?sslmode=disable"
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		slog.Error("unable to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		slog.Error("unable to ping database", "error", err)
		os.Exit(1)
	}

	_, err = pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`)
	if err != nil {
		slog.Error("failed to create migrations table", "error", err)
		os.Exit(1)
	}

	suffix := "." + direction + ".sql"
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		slog.Error("failed to read embedded migrations", "error", err)
		os.Exit(1)
	}

	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), suffix) {
			files = append(files, e.Name())
		}
	}

	if direction == "down" {
		sort.Sort(sort.Reverse(sort.StringSlice(files)))
	} else {
		sort.Strings(files)
	}

	for _, name := range files {
		version := strings.TrimSuffix(name, ".up.sql")
		version = strings.TrimSuffix(version, ".down.sql")

		var exists bool
		err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)", version).Scan(&exists)
		if err != nil {
			slog.Error("failed to check migration status", "version", version, "error", err)
			os.Exit(1)
		}

		if direction == "up" && exists {
			fmt.Printf("  skip  %s (already applied)\n", version)
			continue
		}
		if direction == "down" && !exists {
			fmt.Printf("  skip  %s (not applied)\n", version)
			continue
		}

		sql, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			slog.Error("failed to read embedded migration", "file", name, "error", err)
			os.Exit(1)
		}

		_, err = pool.Exec(ctx, string(sql))
		if err != nil {
			slog.Error("failed to run migration", "file", name, "error", err)
			os.Exit(1)
		}

		if direction == "up" {
			_, err = pool.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", version)
		} else {
			_, err = pool.Exec(ctx, "DELETE FROM schema_migrations WHERE version = $1)", version)
		}
		if err != nil {
			slog.Error("failed to record migration", "version", version, "error", err)
			os.Exit(1)
		}

		fmt.Printf("  %s  %s\n", direction, version)
	}

	fmt.Println("Done.")
}
