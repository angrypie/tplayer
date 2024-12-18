package main

import (
	"bytes"
	"database/sql"
	"embed"
	"io"
	"log"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	_ "modernc.org/sqlite"
)

var (
	//go:embed all:dist
	dist embed.FS
	//go:embed dist/index.html
	indexHtml embed.FS

	distIndexHtml = echo.MustSubFS(indexHtml, "dist")
	distStaticFS  = echo.MustSubFS(dist, "dist/assets")
	rootStaticFS  = echo.MustSubFS(dist, "dist")
)

const (
	sqliteDB  = "tplayer.sqlite"
	historyDB = "tplayer_history.sqlite"
)

func main() {
	e := setupEcho()
	db := setupDatabase()
	defer db.Close()

	historyDb := setupHistoryDatabase()
	defer historyDb.Close()

	e.GET("/api/torrents", handleGetTorrents(historyDb))

	//run ./confluence command shell command in separate process
	cmd := exec.Command("go", "run", "github.com/anacrolix/confluence@latest", "-sqliteStorage="+sqliteDB)
	if err := cmd.Start(); err != nil {
		// fmt.Printf("Failed to start cmd: %v", err)
		panic("Failed to start cmd " + err.Error())
	}

	e.Logger.Fatal(e.Start(":80"))
}

func setupHistoryDatabase() *sql.DB {
	db, err := sql.Open("sqlite", historyDB)
	if err != nil {
		panic(err)
	}

	// Create history table if not exists
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS torrent_history (
			info_hash TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		panic("Failed to create history table: " + err.Error())
	}

	return db
}

func setupDatabase() *sql.DB {
	db, err := sql.Open("sqlite", "file:"+sqliteDB+"?mode=ro")
	if err != nil {
		panic(err)
	}
	return db
}

type TorrentHistory struct {
	InfoHash  string    `json:"info_hash"`
	Name      string    `json:"name"`
	LastSeen  time.Time `json:"last_seen"`
	FirstSeen time.Time `json:"first_seen"`
}

func handleGetTorrents(db *sql.DB) echo.HandlerFunc {
	return func(c echo.Context) error {
		rows, err := db.Query(`
			SELECT info_hash, name, last_seen, first_seen
			FROM torrent_history
			ORDER BY last_seen DESC
		`)
		if err != nil {
			log.Printf("ERROR failed to query torrent history: %v", err)
			return c.JSON(500, map[string]string{"error": err.Error()})
		}
		defer rows.Close()

		torrents := make([]TorrentHistory, 0)
		for rows.Next() {
			var t TorrentHistory
			if err := rows.Scan(&t.InfoHash, &t.Name, &t.LastSeen, &t.FirstSeen); err != nil {
				log.Printf("ERROR failed to scan torrent row: %v", err)
				return c.JSON(500, map[string]string{"error": err.Error()})
			}
			torrents = append(torrents, t)
		}

		if err := rows.Err(); err != nil {
			log.Printf("ERROR error after scanning rows: %v", err)
			return c.JSON(500, map[string]string{"error": err.Error()})
		}

		return c.JSON(200, torrents)
	}
}

func setupEcho() *echo.Echo {
	e := echo.New()
	e.Use(middleware.Recover())
	e.Use(middleware.Logger())

	e.StaticFS("/assets", distStaticFS)
	e.StaticFS("/", rootStaticFS)
	e.FileFS("/", "index.html", distIndexHtml)
	e.FileFS("/playlist/*", "index.html", distIndexHtml)
	//TODO setup proper redirect for spa (for now it's only one page so it's ok)

	url1, err := url.Parse("http://localhost:8080")
	if err != nil {
		e.Logger.Fatal(err)
	}
	targets := []*middleware.ProxyTarget{
		{
			URL: url1,
		},
	}

	historyDb := setupHistoryDatabase()

	proxy := middleware.ProxyWithConfig(middleware.ProxyConfig{
		Skipper: func(c echo.Context) bool {
			path := c.Request().URL.Path
			// Proxy requests that belong to confluence
			if path == "/api/info" || path == "/api/data" {
				// Remove /api prefix before proxying
				c.Request().URL.Path = strings.TrimPrefix(path, "/api")
				return false
			}
			return true
		},
		ModifyResponse: func(resp *http.Response) error {
			// Only process /info responses
			log.Println("INFO extracting torrent info", resp.Request.URL.Path)
			if !strings.HasSuffix(resp.Request.URL.Path, "/info") {
				return nil
			}

			// Get info hash from request query parameter
			infoHash := resp.Request.URL.Query().Get("ih")
			if infoHash == "" {
				log.Println("WARN no info hash in request")
				return nil
			}

			// Read the response body
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return err
			}

			// Close the original body
			resp.Body.Close()
			// Create a new body with the same content
			resp.Body = io.NopCloser(bytes.NewReader(body))
			// Extract torrent name
			name := extractBencodeField(body, "name")
			if name == "" {
				log.Println("WARN no name in torrent data for hash:", infoHash)
				return nil
			}

			log.Printf("INFO saving torrent: %s (%s)", name, infoHash)

			// Update history table
			_, err = historyDb.Exec(`
				INSERT INTO torrent_history (info_hash, name, last_seen)
				VALUES (?, ?, CURRENT_TIMESTAMP)
				ON CONFLICT(info_hash) DO UPDATE SET
					last_seen = CURRENT_TIMESTAMP
			`, infoHash, name)
			if err != nil {
				log.Printf("ERROR failed to save torrent history: %v", err)
				return err
			}
			return nil
		},
		Balancer: middleware.NewRandomBalancer(targets),
	})
	e.Use(proxy)

	return e
}

func extractBencodeField(data []byte, fieldName string) string {
	// Find ":name" pattern
	idx := strings.Index(string(data), ":"+fieldName)
	if idx == -1 {
		return ""
	}

	// Find the number that indicates name length
	start := idx + 5 // skip ":name"
	end := start
	for end < len(data) && data[end] >= '0' && data[end] <= '9' {
		end++
	}
	if end >= len(data) || data[end] != ':' {
		return ""
	}

	// Parse the length
	length, err := strconv.Atoi(string(data[start:end]))
	if err != nil {
		return ""
	}

	// Extract the name
	nameStart := end + 1
	if nameStart+length > len(data) {
		return ""
	}
	return string(data[nameStart : nameStart+length])
}
