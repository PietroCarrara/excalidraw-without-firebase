package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

var fileStore = http.FileServer(http.Dir("./"))

func mainRoute(w http.ResponseWriter, req *http.Request) {
	// Always enable CORS
	w.Header().Add("Access-Control-Allow-Origin", "*")

	if req.URL.Path == "/" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	if strings.ToUpper(req.Method) == "GET" {
		fileStore.ServeHTTP(w, req)
		return
	}

	if strings.ToUpper(req.Method) == "POST" {
		pathFromUrl, _ := strings.CutPrefix(req.URL.Path, "/")
		absolutePathInFilesystem, _ := filepath.Abs(pathFromUrl)
		workingDirectory, _ := os.Getwd()

		if !strings.HasPrefix(absolutePathInFilesystem, workingDirectory) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		os.MkdirAll(filepath.Dir(absolutePathInFilesystem), 0755)
		file, _ := os.Create(absolutePathInFilesystem)
		defer file.Close()
		defer req.Body.Close()

		contents, _ := io.ReadAll(req.Body)
		file.Write(contents)
	}
}

func main() {
	http.HandleFunc("/", mainRoute)

	fmt.Println("Starting up on port 8090")
	http.ListenAndServe(":8090", nil)
}
