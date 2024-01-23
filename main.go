package main

import (
	"embed"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"net/url"
	"os/exec"
)

var (
	//go:embed all:build
	dist embed.FS
	//go:embed build/index.html
	indexHtml embed.FS

	distIndexHtml = echo.MustSubFS(indexHtml, "build")
	distStaticFS  = echo.MustSubFS(dist, "build/static")
)

func main() {
	e := echo.New()
	e.Use(middleware.Recover())
	e.Use(middleware.Logger())

	e.StaticFS("/static", distStaticFS)
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

	// e.Use(middleware.Proxy(middleware.NewRandomBalancer(targets)))

	//run ./confluence command shell command in separate process
	cmd := exec.Command("go", "run", "github.com/anacrolix/confluence@latest", "-sqliteStorage=tplayer.sqlite")
	if err := cmd.Start(); err != nil {
		// fmt.Printf("Failed to start cmd: %v", err)
		panic("Failed to start cmd " + err.Error())
		return
	}

	e.Logger.Fatal(e.Start(":80"))
}
