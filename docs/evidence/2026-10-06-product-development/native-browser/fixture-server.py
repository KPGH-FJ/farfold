from http.server import BaseHTTPRequestHandler,HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  routes={
   '/safe':'<div style="opacity:0">INVISIBLE_PARENT_TEXT</div><span style="position:absolute;top:8000px">OFFSCREEN_TEXT</span><h1>Public sample</h1><div style="width:200px;height:100px;background:#369">Blue tile</div><button onclick="document.querySelector(\'h1\').textContent=\'Clicked once\'">Update heading</button>',
   '/input':'<h1>Writing form</h1><label>Notes<textarea name="notes" placeholder="Write notes"></textarea></label><button>Done</button>',
   '/stale':'<h1>Changing page</h1><button>Original</button><script>setTimeout(()=>document.querySelector("button").textContent="Changed",900)</script>',
   '/secret':'<h1>Login</h1><input type="password" value="MUST_NOT_RETURN_SECRET">',
   '/otp':'<label>验证码<input type="text" value="123456"></label>',
   '/upload':'<input type="file">',
   '/shadow-open':'<h1>Open component</h1><div id="host"></div><script>document.querySelector("#host").attachShadow({mode:"open"}).innerHTML="<textarea>SHADOW_SECRET</textarea>"</script>',
   '/shadow-closed':'<h1>Closed component</h1><div id="host"></div><script>document.querySelector("#host").attachShadow({mode:"closed"}).innerHTML="<textarea>SHADOW_SECRET</textarea>"</script>',
   '/frame':'<h1>Embedded page</h1><iframe src="about:blank"></iframe>',
  }
  body=('<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif;margin:30px}button,textarea{display:block;margin:20px;padding:12px}</style>'+routes.get(self.path,'missing')).encode()
  self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
HTTPServer(('127.0.0.1',18746),Handler).serve_forever()
