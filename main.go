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

	distDirFS     = echo.MustSubFS(dist, "build")
	distIndexHtml = echo.MustSubFS(indexHtml, "build")
)

func main() {
	e := echo.New()
	e.Use(middleware.Recover())
	e.Use(middleware.Logger())

	//handle static from /data
	e.FileFS("/", "index.html", distIndexHtml)
	e.StaticFS("/static", distDirFS)

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
	cmd := exec.Command("~/go/bin/confluence")

	if err := cmd.Start(); err != nil {
		// fmt.Printf("Failed to start cmd: %v", err)
		panic("Failed to start cmd " + err.Error())
		return
	}

	e.Logger.Fatal(e.Start(":80"))
}
