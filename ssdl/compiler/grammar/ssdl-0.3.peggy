{
 const at=value=>({...value,location:location()});
 const binary=(head,tail)=>tail.reduce((a,[,op,,b])=>at({kind:'op',op,args:[a,b]}),head);
 const bad=(code)=>{const e=new Error(code);e.code=code;e.location=location();throw e;};
}
Start = _ imports:(Import _)* root:Node _ !. {return {imports:imports.map(x=>x[0]),root};}
Import = "import" ![A-Za-z_0-9] H dir:String H alias:("as" ![A-Za-z_0-9] H name:Identifier {return name;})? End {return at({kind:'import',directory:dir.value,alias});}
Node = type:Qualified H "{" _ members:(Member _)* "}" {return at({kind:'node',type,members:members.map(x=>x[0])});}
Member = Handler / Declaration / Node / name:MemberName H ":" H value:Expression End {return at({kind:'property',name,value});}
MemberName = head:Identifier tail:("." Identifier)* {return [head,...tail.map(x=>x[1])].join('.');}
Handler = name:$("on" [A-Z] [A-Za-z_0-9]*) H ":" H body:("{" _ actions:(Action _)* "}" {return actions.map(x=>x[0]);} / action:Action {return [action];}) {return at({kind:'handler',name,actions:body});}
Action = target:MemberName H "=" !"=" H value:Expression End {return at({kind:'assignment',target:target.split('.'),value});}
 / target:MemberName H "(" H ")" End {return at({kind:'invoke',target:target.split('.')});}
Declaration = req:("required" ![A-Za-z_0-9] H)? "property" ![A-Za-z_0-9] H type:PropertyType H name:Identifier H value:(":" H e:Expression {return e;})? End {if(req&&value)bad('required_property_default');return at({kind:'declaration',type,name,required:!!req,value});}
PropertyType = name:Identifier {if(!['real','bool','string','length','radians','degrees','duration','url'].includes(name))bad('unsupported_property_type');return name;}
End = H (";" / Newline / &"}")
Expression = Conditional
Conditional = test:Or tail:(H "?" H yes:Expression H ":" H no:Expression {return [yes,no];})? {return tail?at({kind:'op',op:'select',args:[test,...tail]}):test;}
Or = h:And t:(H "||" H And)* {return binary(h,t.map(x=>[x[0],'or',x[2],x[3]]));}
And = h:Compare t:(H "&&" H Compare)* {return binary(h,t.map(x=>[x[0],'and',x[2],x[3]]));}
Compare = h:Sum t:(H op:("===" / "<" / ">") H Sum)* {return binary(h,t.map(x=>[x[0],{'===':'equals','<':'lt','>':'gt'}[x[1]],x[2],x[3]]));}
Sum = h:Product t:(H ("+" / "-") H Product)* {return binary(h,t.map(x=>[x[0],x[1]==='+'?'add':'sub',x[2],x[3]]));}
Product = h:Unary t:(H ("*" / "/") H Unary)* {return binary(h,t.map(x=>[x[0],x[1]==='*'?'mul':'div',x[2],x[3]]));}
Unary = "!" H a:Unary {return at({kind:'op',op:'not',args:[a]});} / "-" H a:Unary {return at({kind:'negative',arg:a});} / Primary
Primary = Constructor / Call / Reference / Number / String / Boolean / Array / "(" H e:Expression H ")" {return e;} / id:Identifier {return at({kind:'identifier',value:id});}
Constructor = unit:('ms' / 'rad' / 'deg' / 'm') ![A-Za-z_0-9] H "(" H token:SignedDecimal H ")" {return at({kind:'number',token:token.startsWith('+')?token.slice(1):token,raw_token:token,unit});}
Call = name:Identifier H "(" H args:(h:Expression t:(H "," H Expression)* {return [h,...t.map(x=>x[3])];})? H ")" {if(['m','rad','deg','ms'].includes(name))bad('unit_constructor_token_required');if(!['min','max','clamp','lerp'].includes(name))bad('unknown_function');return at({kind:'call',name,args:args||[]});}
Reference = head:Identifier tail:("." Identifier)+ {return at({kind:'reference',segments:[head,...tail.map(x=>x[1])]});}
Array = "[" H values:(h:Expression t:(H "," H Expression)* {return [h,...t.map(x=>x[3])];})? H "]" {return at({kind:'array',values:values||[]});}
Number = token:Decimal suffix:(H ('scalar' / 'rad' / 'deg' / 'ms' / 'm') ![A-Za-z_0-9])? ![A-Za-z_0-9] {if(suffix)bad('legacy_unit_syntax');return at({kind:'number',token,unit:'scalar'});}
SignedDecimal = $([+-]? ('0' / [1-9][0-9]*) ('.'[0-9]+)? ([eE][+-]?[0-9]+)?)
Decimal = $(('0' / [1-9][0-9]*) ('.'[0-9]+)? ([eE][+-]?[0-9]+)?)
String = token:$( '"' ('\\' (["\\/bfnrt] / 'u' [0-9a-fA-F]{4}) / [^"\\\x00-\x1f])* '"') {return at({kind:'literal',value:JSON.parse(token)});}
Boolean = value:("true" / "false") ![A-Za-z_0-9] {return at({kind:'literal',value:value==='true'});}
Qualified = head:Identifier tail:("." Identifier)? {return tail?head+'.'+tail[1]:head;}
Identifier = $([A-Za-z_][A-Za-z_0-9]*)
Newline = "\r\n" / "\r" / "\n"
LineComment = "//" [^\r\n]*
BlockComment = "/*" (!"*/" .)* "*/"
H = ([ \t] / BlockComment / LineComment)*
_ = ([ \t\r\n;] / BlockComment / LineComment)*
