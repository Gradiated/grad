package generated_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// TestEveryOperation calls each generated method once against a fake that answers
// any route, proving each builds a request and decodes (or streams) the reply.
func TestEveryOperation(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path)
		n := len(seen)
		mu.Unlock()
		if n > 200 {
			t.Errorf("more than 200 requests")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		accept := r.Header.Get("Accept")
		switch {
		case strings.Contains(accept, "text/event-stream"):
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: metric\nid: 1\ndata: {}\n\n")
		case strings.Contains(accept, "json"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":[],"next_cursor":null}`)
		default:
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = io.WriteString(w, "bytes")
		}
	}))
	defer srv.Close()
	zero := 0
	tr, err := generated.NewTransport(generated.Config{BaseURL: srv.URL, APIKey: "grad_test", MaxRetries: &zero})
	if err != nil {
		t.Fatal(err)
	}
	client := reflect.ValueOf(generated.NewClient(tr))
	ctxType := reflect.TypeOf((*context.Context)(nil)).Elem()
	methods := 0
	for i := 0; i < client.NumMethod(); i++ {
		m := client.Type().Method(i)
		fn := client.Method(i)
		ft := fn.Type()
		if ft.NumIn() == 0 || ft.In(0) != ctxType {
			continue
		}
		methods++
		args := []reflect.Value{reflect.ValueOf(context.Background())}
		for j := 1; j < ft.NumIn(); j++ {
			if ft.IsVariadic() && j == ft.NumIn()-1 {
				break
			}
			in := ft.In(j)
			switch in.Kind() {
			case reflect.String:
				args = append(args, reflect.ValueOf("x_1").Convert(in))
			case reflect.Ptr:
				args = append(args, reflect.New(in.Elem()))
			default:
				args = append(args, reflect.Zero(in))
			}
		}
		out := fn.Call(args)
		for _, v := range out {
			if closer, ok := v.Interface().(io.Closer); ok && !v.IsNil() {
				// Streams: drain the SSE iterator when there is one, then close.
				if next := v.MethodByName("Next"); next.IsValid() {
					for next.Call(nil)[0].Bool() {
					}
				}
				_ = closer.Close()
			}
		}
		if errV := out[len(out)-1]; !errV.IsNil() {
			t.Errorf("%s: %v", m.Name, errV.Interface())
		}
	}
	if methods < 50 || len(seen) != methods {
		t.Fatalf("%d methods, %d requests", methods, len(seen))
	}
}
