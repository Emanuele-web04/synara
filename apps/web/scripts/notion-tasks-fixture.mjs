/** Deterministic transport fixture for actual Synara Tasks components; never live OAuth. */
export const taskFixture = String.raw`
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter, createRootRoute, createMemoryHistory } from '@tanstack/react-router';
import TasksView from '~/components/tasks/TasksView';
import { SidebarProvider } from '~/components/ui/sidebar';
import { useTodoEventSubscription } from '~/components/tasks/useTodos';
import { useStore } from '~/store';
import { useTheme } from '~/hooks/useTheme';
import '~/index.css';
const ds='11111111-1111-4111-8111-111111111111';
const pageId='22222222-2222-4222-8222-222222222222';
const rich=content=>[{type:'text',text:{content},plain_text:content,annotations:{}}];
const source={object:'data_source',id:ds,title:rich('Engineering tasks'),properties:{
  Name:{id:'title',type:'title',title:{}},
  Status:{id:'status',type:'status',status:{options:[{id:'doing',name:'In progress'}]}},
}};
const record={object:'page',id:pageId,parent:{type:'data_source_id',data_source_id:ds},properties:{
  Name:{id:'title',type:'title',title:rich('Review OAuth permissions')},
  Status:{id:'status',type:'status',status:{id:'doing',name:'In progress'}},
}};
const local={id:'local-task',title:'Prepare the team update',notes:'A local Synara task.',priority:'none',projectId:'project-a',dueDate:null,threadId:null,delegationBaseTurnId:null,linkedAt:null,completedAt:null,createdAt:'2026-10-16T08:00:00.000Z',updatedAt:'2026-10-16T08:00:00.000Z'};
const remote={...local,id:'notion:'+pageId,title:'Review OAuth permissions',notes:'Preserve OAuth grants and independent agent execution.',external:{provider:'notion',connectionId:'fixture:bot',mappingId:'tasks',dataSourceId:ds,pageId,url:'https://www.notion.so/'+pageId.replaceAll('-',''),workspaceName:'Engineering',status:'In progress',statusId:'doing',assignees:['Alex'],assigneeIds:['33333333-3333-4333-8333-333333333333'],sprintIds:[],epicIds:[],milestoneIds:[],dependencyIds:[],subtaskIds:[],startDate:null,storyPoints:null,syncState:'synced',syncMessage:null,writableFields:['title','notes']}};
const todos=[remote,local];
const listeners=new Set();
const mapping={id:'tasks',connectionId:'fixture:bot',dataSourceId:ds,name:'Engineering tasks',projectId:'project-a',fields:{title:{id:'title',type:'title'},status:{id:'status',type:'status'}},completedStatusIds:[],reopenedStatusId:null,priorityOptions:{},agentAccess:'none',agentPageIds:[],enabled:true};
const state={configured:true,syncing:false,lastSyncedAt:'2026-10-16T08:00:00.000Z',syncError:null,changes:[],connections:[{id:'fixture:bot',workspaceId:ds,workspaceName:'Engineering',status:'connected',createdAt:'2026-10-16T08:00:00.000Z'}],mappings:[mapping]};
const list=results=>({object:'list',results,has_more:false,next_cursor:null});
globalThis.__writes=[];
globalThis.__notionApi={
 shell:{openExternal:async()=>{}},
 server:{getConfig:async()=>({cwd:'/fixture/synara',providers:[],homeDir:'/fixture',capabilities:[]})},
 todo:{list:async()=>({todos:structuredClone(todos)}),onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},update:async input=>{globalThis.__writes.push(input);throw new Error('Unexpected fixture mutation');},create:async()=>{throw new Error('Unexpected fixture creation');},delete:async()=>{throw new Error('Unexpected fixture deletion');}},
 notion:{state:async()=>structuredClone(state),read:async input=>{
  let data;
  if(input.kind==='dataSource')data=source;
  else if(input.kind==='query')data=list([record]);
  else if(input.kind==='page')data=record;
  else if(['children','comments','users','views'].includes(input.kind))data=list([]);
  else if(input.kind==='search')data=list([source,record].filter(value=>!input.query||(value.title?.[0]?.plain_text??value.properties.Name.title[0].plain_text).toLowerCase().includes(input.query.toLowerCase())));
  else throw new Error('Unexpected fixture read: '+input.kind);
  return {data:structuredClone(data)};
 },write:async()=>{throw new Error('Unexpected Notion mutation');}},
};
useStore.setState({projects:[{id:'project-a',name:'Synara',cwd:'/fixture/synara',kind:'project',createdAt:'2026-10-16T08:00:00.000Z',updatedAt:'2026-10-16T08:00:00.000Z',scripts:[]}],snapshotReceived:true});
globalThis.__incoming=()=>{const todo={...remote,id:'incoming',title:'New colleague-assigned task'};todos.push(todo);for(const listener of listeners)listener({type:'todo-upserted',todo});};
function App(){
 const {setTheme}=useTheme();globalThis.__setTheme=setTheme;
 useTodoEventSubscription();
 return <SidebarProvider defaultOpen={false}><div className="w-full"><p className="px-6 py-2 text-ui-xs text-muted-foreground">Synara Tasks · actual components · fixture API · no live OAuth</p><TasksView/></div></SidebarProvider>;
}
const route=createRootRoute({component:App,errorComponent:({error})=>{globalThis.__renderError=String(error.stack||error);return <pre>{globalThis.__renderError}</pre>;}});
const router=createRouter({routeTree:route,history:createMemoryHistory({initialEntries:['/']})});
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><RouterProvider router={router}/></QueryClientProvider>);
`;
