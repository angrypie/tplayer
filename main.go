package main

import (
	"database/sql"
	"embed"
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
	//go:embed all:build
	dist embed.FS
	//go:embed build/index.html
	indexHtml embed.FS

	distIndexHtml = echo.MustSubFS(indexHtml, "build")
	distStaticFS  = echo.MustSubFS(dist, "build/static")
)

const sqliteDB = "tplayer.sqlite"

func extractTorrentName(data []byte) string {
	// Find ":name" pattern
	idx := strings.Index(string(data), ":name")
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

func main() {
	e := echo.New()
	e.Use(middleware.Recover())
	e.Use(middleware.Logger())

	e.StaticFS("/static", distStaticFS)
	e.FileFS("/", "index.html", distIndexHtml)
	e.FileFS("/playlist/*", "index.html", distIndexHtml)
	//TODO setup proper redirect for spa (for now it's only one page so it's ok)

	// Initialize SQLite database connection reoad mode
	db, err := sql.Open("sqlite", "file:"+sqliteDB+"?mode=ro")
	if err != nil {
		e.Logger.Fatal(err)
	}
	defer db.Close()

	// Add /api/torrents endpoint
	e.GET("/api/torrents", func(c echo.Context) error {
		type Torrent struct {
			InfoHash    string    `json:"info_hash"`
			Name        string    `json:"name"`
			StoreTime   time.Time `json:"store_time"`
			LastUsed    time.Time `json:"last_used"`
			AccessCount int       `json:"access_count"`
		}

		rows, err := db.Query(`
			SELECT b.name, b.store_time, b.last_used, b.access_count, bd.data 
			FROM blob b 
			JOIN blob_data bd ON b.data_id = bd.data_id 
			WHERE b.name LIKE 'torrent%'
		`)
		if err != nil {
			return c.JSON(500, map[string]string{"error": err.Error()})
		}
		defer rows.Close()

		var torrents []Torrent
		for rows.Next() {
			var t Torrent
			var fullName string
			var storeTimeMs, lastUsedMs int64
			var data []byte
			if err := rows.Scan(&fullName, &storeTimeMs, &lastUsedMs, &t.AccessCount, &data); err != nil {
				return c.JSON(500, map[string]string{"error": err.Error()})
			}

			// Extract infohash from "torrents/[infohash].torrent"
			t.InfoHash = fullName[9 : len(fullName)-8]
			t.StoreTime = time.UnixMilli(storeTimeMs)
			t.LastUsed = time.UnixMilli(lastUsedMs)

			// Extract torrent name from bencode data
			t.Name = extractTorrentName(data)

			torrents = append(torrents, t)
		}

		return c.JSON(200, torrents)
	})

	url1, err := url.Parse("http://localhost:8080")
	if err != nil {
		e.Logger.Fatal(err)
	}
	targets := []*middleware.ProxyTarget{
		{
			URL: url1,
		},
	}

	proxy := middleware.ProxyWithConfig(middleware.ProxyConfig{
		Skipper: func(c echo.Context) bool {
			path := c.Request().URL.Path
			if path == "/info" || path == "/data" {
				return false
			}
			return true
		},
		Balancer: middleware.NewRandomBalancer(targets),
	})
	e.Use(proxy)

	//run ./confluence command shell command in separate process
	cmd := exec.Command("go", "run", "github.com/anacrolix/confluence@latest", "-sqliteStorage="+sqliteDB)
	if err := cmd.Start(); err != nil {
		// fmt.Printf("Failed to start cmd: %v", err)
		panic("Failed to start cmd " + err.Error())
	}

	e.Logger.Fatal(e.Start(":80"))
}
