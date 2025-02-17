package main

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const MEGABYTES = 1000000 // in bytes

var cachedStore = &cachedFs{
	cache:         map[string]*cachedEntry{},
	maxSizeBytes:  15 * MEGABYTES,
	writeInterval: 10 * time.Second,
}

func mainRoute(w http.ResponseWriter, req *http.Request) {
	// Always enable CORS
	w.Header().Add("Access-Control-Allow-Origin", "*")

	pathFromUrl, _ := strings.CutPrefix(req.URL.Path, "/")
	absolutePathInFilesystem, _ := filepath.Abs(pathFromUrl)
	workingDirectory, _ := os.Getwd()

	if pathFromUrl == "" || !strings.HasPrefix(absolutePathInFilesystem, workingDirectory) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	if strings.ToUpper(req.Method) == "GET" {
		data, _ := cachedStore.Read(absolutePathInFilesystem)
		io.Copy(w, data)
		return
	}

	if strings.ToUpper(req.Method) == "POST" {
		defer req.Body.Close()
		cachedStore.Write(absolutePathInFilesystem, req.Body)
	}
}

type cachedFs struct {
	cache         map[string]*cachedEntry
	rwlock        sync.RWMutex
	maxSizeBytes  uint64
	writeInterval time.Duration
}

type cachedEntry struct {
	accessCount            int
	data                   []byte
	needsToBeWrittenOnDisk bool
	lastModifiedTime       time.Time
}

func (c *cachedFs) Start() {
	go func() {
		for {
			time.Sleep(c.writeInterval)

			c.rwlock.Lock()
			for fname, data := range c.cache {
				if data.needsToBeWrittenOnDisk {
					os.MkdirAll(filepath.Dir(fname), 0755)
					file, err := os.Create(fname)
					if err != nil {
						log.Printf("error while creating file for persisting \"%s\": %s\n", fname, err)
						continue
					}
					defer file.Close()

					_, err = file.Write(data.data)
					if err != nil {
						log.Printf("error while persisting \"%s\": %s\n", fname, err)
						continue
					}
					log.Printf("persisted \"%s\"", fname)
				}
				data.needsToBeWrittenOnDisk = false
			}
			c.rwlock.Unlock()
		}
	}()
}

func (c *cachedFs) Read(name string) (io.Reader, error) {
	c.rwlock.RLock()
	contents, exists := c.cache[name]
	c.rwlock.RUnlock()

	stat, err := os.Stat(name)
	if err != nil {
		return nil, err
	}
	modifiedTime := stat.ModTime()

	if !exists || modifiedTime.After(contents.lastModifiedTime) {
		file, err := os.Open(name)
		defer file.Close()
		if err != nil {
			return nil, err
		}

		filecontents, err := io.ReadAll(file)
		if err != nil {
			return nil, err
		}

		c.rwlock.Lock()
		contents = &cachedEntry{
			accessCount:            1,
			data:                   filecontents,
			needsToBeWrittenOnDisk: false,
			lastModifiedTime:       modifiedTime,
		}
		c.cache[name] = contents
		c.rwlock.Unlock()
	}

	return io.NopCloser(bytes.NewBuffer(contents.data)), nil
}

func (c *cachedFs) Write(name string, contents io.Reader) error {
	var sizeBytes uint64 = 0

	c.rwlock.RLock()
	for _, v := range c.cache {
		sizeBytes += uint64(len(v.data))
	}
	oldAccessCount := 0
	if oldContents, exists := c.cache[name]; exists {
		oldAccessCount = oldContents.accessCount
	}

	c.rwlock.RUnlock()

	if sizeBytes > c.maxSizeBytes {
		c.rwlock.Lock()
		// TODO
		c.rwlock.Unlock()
	}

	buf, err := io.ReadAll(contents)
	if err != nil {
		return err
	}

	c.rwlock.Lock()
	c.cache[name] = &cachedEntry{
		accessCount:            oldAccessCount + 1,
		data:                   buf,
		needsToBeWrittenOnDisk: true,
		lastModifiedTime:       time.Now(),
	}
	c.rwlock.Unlock()

	return nil
}

func main() {
	cachedStore.Start()

	http.HandleFunc("/", mainRoute)

	fmt.Println("Starting up on port 8090")
	http.ListenAndServe(":8090", nil)
}
